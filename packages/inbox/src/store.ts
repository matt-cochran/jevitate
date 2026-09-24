import { mkdir, open, readFile, readdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { writeFileAtomic } from "./atomic.js";
import { withIdLock } from "./lock.js";
import { flushIfDurable } from "./durability.js";
import type { Action, InboxItem, InboxSummary, ThreadEntry } from "./types.js";
import { InboxItemSchema, SAFE_INBOX_ID_RE, assertSafeInboxId, asSecret, resolveTransition, toSummary } from "./types.js";

export type Channel = "human" | "agent";

/**
 * The build serving this store (#112): handed in as data by the host (the CLI), never read here —
 * this package does not know how it was built. `commit`/`builtAt` are reported when given.
 */
export interface BuildIdentity {
  readonly version: string;
  readonly commit: string;
  readonly builtAt: string;
}

export interface InboxHealth {
  ok: boolean;
  pending: number;
  oldestPendingAgeSec: number;
  version: string;
  commit?: string;
  builtAt?: string;
}

export interface InboxStore {
  enqueue(item: InboxItem): Promise<void>;
  getSummaries(now?: number): Promise<InboxSummary[]>;
  get(id: string): Promise<InboxItem | null>;
  getForAgent(id: string): Promise<InboxItem | null>;
  resolve(id: string, req: { channel: Channel; action: Action; input?: string }): Promise<InboxItem>;
  appendThread(id: string, entry: ThreadEntry): Promise<InboxItem>;
  sweepExpired(now?: number): Promise<number>;
  health(now?: number): Promise<InboxHealth>;
}

export class InboxItemNotFoundError extends Error {
  constructor(id: string) {
    super(`inbox item not found: ${id}`);
    this.name = "InboxItemNotFoundError";
  }
}

export class InboxItemAlreadyResolvedError extends Error {
  constructor(id: string) {
    super(`inbox item already resolved: ${id}`);
    this.name = "InboxItemAlreadyResolvedError";
  }
}

export class HumanApprovalRequiredError extends Error {
  constructor(id: string) {
    super(`inbox item requires human approval, agent channel cannot resolve: ${id}`);
    this.name = "HumanApprovalRequiredError";
  }
}

export class IllegalTransitionError extends Error {
  constructor(kind: string, action: string) {
    super(`illegal transition: kind=${kind} action=${action}`);
    this.name = "IllegalTransitionError";
  }
}

export class InboxIdConflictError extends Error {
  constructor(id: string) {
    super(`inbox item already exists: ${id}`);
    this.name = "InboxIdConflictError";
  }
}

function isNodeError(err: unknown, code: string): boolean {
  return typeof err === "object" && err !== null && "code" in err && (err as { code?: unknown }).code === code;
}

const TERMINAL_STATUSES = new Set(["approved", "rejected", "resolved", "expired"]);

/**
 * Filesystem-backed inbox store — the durable message bus between an agent
 * (via MCP) and a human (via the local UI). See task-4-brief.md for the
 * full invariant list (SM1/SM2/SM3, S-E, S-G, C-B).
 */
export class FsInboxStore implements InboxStore {
  private readonly identity: { version: string; commit?: string; builtAt?: string };

  /** `build`: the serving build's identity (or just its version) — reported by `health()`. */
  constructor(
    private readonly dir: string,
    build: string | BuildIdentity = "0.0.0",
  ) {
    this.identity =
      typeof build === "string" ? { version: build } : { version: build.version, commit: build.commit, builtAt: build.builtAt };
  }

  private hotPath(id: string): string {
    return join(this.dir, `${id}.json`);
  }

  private archivePath(id: string): string {
    return join(this.dir, "archive", `${id}.json`);
  }

  private archiveDir(): string {
    return join(this.dir, "archive");
  }

  /** Reads and validates the hot file, or null on ENOENT. Throws on malformed content (fail-closed). */
  private async readHot(id: string): Promise<InboxItem | null> {
    let raw: string;
    try {
      raw = await readFile(this.hotPath(id), "utf8");
    } catch (err) {
      if (isNodeError(err, "ENOENT")) return null;
      throw err;
    }
    return InboxItemSchema.parse(JSON.parse(raw));
  }

  /** Reads and validates the archive file, or null on ENOENT. Throws on malformed content (fail-closed). */
  private async readArchive(id: string): Promise<InboxItem | null> {
    let raw: string;
    try {
      raw = await readFile(this.archivePath(id), "utf8");
    } catch (err) {
      if (isNodeError(err, "ENOENT")) return null;
      throw err;
    }
    return InboxItemSchema.parse(JSON.parse(raw));
  }

  async enqueue(item: InboxItem): Promise<void> {
    const validated = InboxItemSchema.parse(item);
    assertSafeInboxId(validated.id);
    await withIdLock(this.dir, validated.id, async () => {
      await mkdir(this.dir, { recursive: true, mode: 0o700 });
      const serialized = JSON.stringify(validated);
      let fh;
      try {
        fh = await open(this.hotPath(validated.id), "wx", 0o600);
      } catch (err) {
        if (isNodeError(err, "EEXIST")) throw new InboxIdConflictError(validated.id);
        throw err;
      }
      try {
        await fh.writeFile(serialized);
        await flushIfDurable(fh);
      } finally {
        await fh.close();
      }
    });
  }

  async getSummaries(now = Date.now()): Promise<InboxSummary[]> {
    let entries: string[];
    try {
      entries = await readdir(this.dir);
    } catch (err) {
      if (isNodeError(err, "ENOENT")) return [];
      throw err;
    }
    const items: InboxItem[] = [];
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      if (entry.startsWith(".")) continue;
      try {
        const raw = await readFile(join(this.dir, entry), "utf8");
        const parsed = InboxItemSchema.parse(JSON.parse(raw));
        if (parsed.status === "pending") items.push(parsed);
      } catch {
        // Defensive skip (S-G): one corrupt/tampered hot file must not 500 the poll.
        continue;
      }
    }
    items.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    return items.map((it) => toSummary(it, now));
  }

  async get(id: string): Promise<InboxItem | null> {
    assertSafeInboxId(id);
    const hot = await this.readHot(id);
    if (hot) return hot;
    return this.readArchive(id);
  }

  async getForAgent(id: string): Promise<InboxItem | null> {
    assertSafeInboxId(id);
    return withIdLock(this.dir, id, async () => {
      let path: string;
      let item = await this.readHot(id);
      if (item) {
        path = this.hotPath(id);
      } else {
        item = await this.readArchive(id);
        if (!item) return null;
        path = this.archivePath(id);
      }

      if (item.humanInput !== undefined && item.secretConsumedAt === undefined) {
        const consumedAt = new Date().toISOString();
        const returned: InboxItem = { ...item, secretConsumedAt: consumedAt };
        const burned: InboxItem = { ...returned };
        delete burned.humanInput;
        const validatedBurned = InboxItemSchema.parse(burned);
        await writeFileAtomic(path, JSON.stringify(validatedBurned));
        return InboxItemSchema.parse(returned);
      }
      return item;
    });
  }

  async resolve(id: string, req: { channel: Channel; action: Action; input?: string }): Promise<InboxItem> {
    assertSafeInboxId(id);
    // SM1: agents never resolve — human approval is enforced FIRST, before any
    // lookup, so an agent caller gets one uniform refusal regardless of
    // whether the item exists, is pending, or is already terminal (an agent
    // must not be able to distinguish those states via error type).
    if (req.channel === "agent") throw new HumanApprovalRequiredError(id);
    return withIdLock(this.dir, id, async () => {
      const item = await this.readHot(id);
      if (!item) {
        // Not in hot dir: either it never existed, or it is already terminal (archived).
        const archived = await this.readArchive(id);
        if (archived) throw new InboxItemAlreadyResolvedError(id);
        throw new InboxItemNotFoundError(id);
      }
      if (TERMINAL_STATUSES.has(item.status)) throw new InboxItemAlreadyResolvedError(id);

      const transition = resolveTransition(item.kind, req.action);
      if (transition === "illegal") throw new IllegalTransitionError(item.kind, req.action);

      const now = new Date().toISOString();
      const updated: InboxItem = { ...item, status: transition, resolvedAt: now };

      if (req.action === "resume" && req.input !== undefined) {
        updated.humanInput = asSecret(req.input);
        updated.thread = [...updated.thread, { author: "human", text: "human provided input", at: now }];
      }

      const decision =
        transition === "approved" || transition === "rejected" || transition === "resolved" ? transition : "resolved";
      updated.resolution = { by: "human", decision, at: now };

      const validated = InboxItemSchema.parse(updated);
      await mkdir(this.archiveDir(), { recursive: true, mode: 0o700 });
      await writeFileAtomic(this.archivePath(id), JSON.stringify(validated));
      await unlink(this.hotPath(id));
      return validated;
    });
  }

  async appendThread(id: string, entry: ThreadEntry): Promise<InboxItem> {
    assertSafeInboxId(id);
    return withIdLock(this.dir, id, async () => {
      const item = await this.readHot(id);
      if (!item) {
        const archived = await this.readArchive(id);
        if (archived) throw new InboxItemAlreadyResolvedError(id);
        throw new InboxItemNotFoundError(id);
      }
      if (TERMINAL_STATUSES.has(item.status)) throw new InboxItemAlreadyResolvedError(id);

      const updated: InboxItem = { ...item, thread: [...item.thread, entry] };
      const validated = InboxItemSchema.parse(updated);
      await writeFileAtomic(this.hotPath(id), JSON.stringify(validated));
      return validated;
    });
  }

  async sweepExpired(now = Date.now()): Promise<number> {
    let entries: string[];
    try {
      entries = await readdir(this.dir);
    } catch (err) {
      if (isNodeError(err, "ENOENT")) return 0;
      throw err;
    }
    let count = 0;
    for (const entry of entries) {
      if (!entry.endsWith(".json") || entry.startsWith(".")) continue;
      const id = entry.slice(0, -".json".length);
      if (!SAFE_INBOX_ID_RE.test(id)) continue;
      let expired = false;
      try {
        expired = await withIdLock(this.dir, id, async () => {
          const item = await this.readHot(id);
          if (!item || item.status !== "pending") return false;
          if (now - Date.parse(item.createdAt) <= item.ttlSec * 1000) return false;

          const at = new Date(now).toISOString();
          // TTL expiry is an automated timeout, NOT a human decision (SM1) —
          // set status only and omit `resolution` entirely so the audit
          // trail never fabricates `by:"human"` for a machine-driven expiry.
          const updated: InboxItem = { ...item, status: "expired", resolvedAt: at };
          delete updated.humanInput;
          const validated = InboxItemSchema.parse(updated);
          await mkdir(this.archiveDir(), { recursive: true, mode: 0o700 });
          await writeFileAtomic(this.archivePath(id), JSON.stringify(validated));
          await unlink(this.hotPath(id));
          return true;
        });
      } catch {
        // Skip a hot file that fails to parse/validate — sweep is a lifecycle
        // operation, not a hard read path (mirrors getSummaries' defensive skip).
        expired = false;
      }
      if (expired) count++;
    }
    return count;
  }

  async health(now = Date.now()): Promise<InboxHealth> {
    let entries: string[];
    try {
      entries = await readdir(this.dir);
    } catch (err) {
      if (isNodeError(err, "ENOENT")) entries = [];
      else throw err;
    }
    let pending = 0;
    let oldestMtimeMs: number | undefined;
    for (const entry of entries) {
      if (!entry.endsWith(".json") || entry.startsWith(".")) continue;
      const full = join(this.dir, entry);
      try {
        const st = await stat(full);
        if (!st.isFile()) continue;
        pending++;
        if (oldestMtimeMs === undefined || st.mtimeMs < oldestMtimeMs) oldestMtimeMs = st.mtimeMs;
      } catch {
        continue;
      }
    }
    const oldestPendingAgeSec = oldestMtimeMs === undefined ? 0 : Math.max(0, Math.floor((now - oldestMtimeMs) / 1000));
    return { ok: true, pending, oldestPendingAgeSec, ...this.identity };
  }
}
