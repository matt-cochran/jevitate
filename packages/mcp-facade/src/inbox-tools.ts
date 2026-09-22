import {
  SAFE_INBOX_ID_RE,
  InboxIdConflictError,
  type InboxStore,
  type InboxItem,
  type InboxItemKind,
  type InboxSummary,
  type ThreadEntry,
  type Finding,
} from "@jevitate/inbox";

/**
 * The 8 HITL inbox tools MCP will expose (see `tools.ts` `ALLOWED_TOOLS`):
 * `list_incoming`, `get_command`, `get_thread`, `queue_action`,
 * `queue_retrieval`, `approve_action`, `cancel_command`, `get_site_health`.
 *
 * Style mirrors `ai-tools.ts`/`journey-tools.ts`: pure functions, the store
 * injected, no fs access here. VALIDATION FAILURES RETURN a typed
 * `{ error: "invalid_args", message }` object — never a throw.
 *
 * SM1 (enforced twice, belt-and-braces): `facadeApproveAction` and
 * `facadeCancelCommand` ALWAYS refuse and never touch the store — an agent
 * can never approve or cancel over MCP, only a human via the local UI
 * (`FsInboxStore.resolve` also refuses the `channel: "agent"` case, but this
 * facade layer refuses before the store is even reached).
 *
 * Secret-projection invariant: only `facadeGetCommand` (the agent poll path,
 * via `store.getForAgent`, burn-after-read) can ever return `humanInput`.
 * `facadeListIncoming` projects `InboxSummary` (no secret field exists on
 * that type) and `facadeGetThread` projects only `item.thread`
 * (`ThreadEntry` also carries no secret field) — both are safe BY
 * CONSTRUCTION, not by redaction.
 */

export interface InvalidArgsError {
  error: "invalid_args";
  message: string;
}

export interface NotFoundError {
  error: "not_found";
}

export interface HumanApprovalRequiredError {
  error: "human_approval_required";
  message: string;
}

export interface QueuedResult {
  id: string;
  status: "pending";
}

const DEFAULT_TTL_SEC = 3600;
const QUEUE_KINDS = ["approval", "handback", "review"] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseIdArgs(args: unknown): { ok: true; id: string } | { ok: false; message: string } {
  if (!isPlainObject(args)) return { ok: false, message: "expected an object with a string 'id'" };
  const { id } = args;
  if (typeof id !== "string" || id.length === 0) return { ok: false, message: "'id' must be a non-empty string" };
  if (!SAFE_INBOX_ID_RE.test(id)) return { ok: false, message: `'id' is not a safe inbox id: ${JSON.stringify(id)}` };
  return { ok: true, id };
}

/** `store.getSummaries()` already returns only `InboxSummary` — a shape with
 *  no secret field — so this is a structural, not redaction-based, guarantee. */
export async function facadeListIncoming(store: InboxStore): Promise<{ items: InboxSummary[] }> {
  return { items: await store.getSummaries() };
}

/**
 * The ONLY facade that can return `humanInput` — burn-after-read via
 * `store.getForAgent`. A still-pending item comes back with `status:
 * "pending"` and no `resolution` (the agent poll contract); the caller polls
 * again later.
 */
export async function facadeGetCommand(
  store: InboxStore,
  args: unknown,
): Promise<InboxItem | NotFoundError | InvalidArgsError> {
  const parsed = parseIdArgs(args);
  if (!parsed.ok) return { error: "invalid_args", message: parsed.message };
  const item = await store.getForAgent(parsed.id);
  if (!item) return { error: "not_found" };
  return item;
}

/** Projects only `item.thread` (`ThreadEntry[]`, no secret field) — never
 *  the full item, so `humanInput` can never reach this path. */
export async function facadeGetThread(
  store: InboxStore,
  args: unknown,
): Promise<{ thread: ThreadEntry[] } | NotFoundError | InvalidArgsError> {
  const parsed = parseIdArgs(args);
  if (!parsed.ok) return { error: "invalid_args", message: parsed.message };
  const item = await store.get(parsed.id);
  if (!item) return { error: "not_found" };
  return { thread: item.thread };
}

interface QueueCommonFields {
  run: string;
  journey: string;
  step: string;
  reason: string;
  agent: string;
  targetUrl?: string;
  hasScreenshot: boolean;
  findings?: Finding[];
}

function isValidFinding(f: unknown): f is Finding {
  if (!isPlainObject(f)) return false;
  if (typeof f.id !== "string" || typeof f.title !== "string") return false;
  if (f.severity !== "low" && f.severity !== "med" && f.severity !== "high") return false;
  if (f.evidence !== undefined && typeof f.evidence !== "string") return false;
  return true;
}

function parseQueueCommonFields(
  args: unknown,
): { ok: true; value: QueueCommonFields } | { ok: false; message: string } {
  if (!isPlainObject(args)) return { ok: false, message: "expected an object" };

  for (const key of ["run", "journey", "step", "reason", "agent"] as const) {
    const v = args[key];
    if (typeof v !== "string" || v.length === 0) {
      return { ok: false, message: `'${key}' must be a non-empty string` };
    }
  }

  if (args.targetUrl !== undefined && typeof args.targetUrl !== "string") {
    return { ok: false, message: "'targetUrl' must be a string when provided" };
  }
  if (args.hasScreenshot !== undefined && typeof args.hasScreenshot !== "boolean") {
    return { ok: false, message: "'hasScreenshot' must be a boolean when provided" };
  }

  let findings: Finding[] | undefined;
  if (args.findings !== undefined) {
    if (!Array.isArray(args.findings) || !args.findings.every(isValidFinding)) {
      return {
        ok: false,
        message: "'findings' must be an array of { id, title, severity: 'low'|'med'|'high', evidence? }",
      };
    }
    findings = args.findings;
  }

  return {
    ok: true,
    value: {
      run: args.run as string,
      journey: args.journey as string,
      step: args.step as string,
      reason: args.reason as string,
      agent: args.agent as string,
      targetUrl: args.targetUrl as string | undefined,
      hasScreenshot: (args.hasScreenshot as boolean | undefined) ?? false,
      findings,
    },
  };
}

/** Sanitizes `run` into the `[a-z0-9_-]` alphabet and appends a timestamp +
 *  random suffix so ids are unique without ever needing caller input. Always
 *  starts with the (lowercase-alpha) `kind`, so the result always matches
 *  `SAFE_INBOX_ID_RE` regardless of what `run` contained. */
function synthesizeInboxId(kind: InboxItemKind, run: string): string {
  const cleanRun = run.toLowerCase().replace(/[^a-z0-9_-]/g, "-").replace(/-+/g, "-").replace(/^-+|-+$/g, "");
  const base = cleanRun.length > 0 ? cleanRun : "run";
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 10);
  return `${kind}-${base}-${ts}-${rand}`.slice(0, 64);
}

async function enqueueQueueItem(
  store: InboxStore,
  kind: InboxItemKind,
  fields: QueueCommonFields,
): Promise<QueuedResult> {
  const MAX_ATTEMPTS = 5;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const id = synthesizeInboxId(kind, fields.run);
    const item: InboxItem = {
      id,
      kind,
      status: "pending",
      run: fields.run,
      journey: fields.journey,
      step: fields.step,
      reason: fields.reason,
      agent: fields.agent,
      hasScreenshot: fields.hasScreenshot,
      thread: [],
      createdAt: new Date().toISOString(),
      ttlSec: DEFAULT_TTL_SEC,
      ...(fields.targetUrl !== undefined ? { targetUrl: fields.targetUrl } : {}),
      ...(fields.findings !== undefined ? { findings: fields.findings } : {}),
    };
    try {
      await store.enqueue(item);
      return { id, status: "pending" };
    } catch (err) {
      // Astronomically unlikely (timestamp + random suffix), but never let a
      // collision surface as an opaque throw — retry with a fresh id.
      if (err instanceof InboxIdConflictError && attempt < MAX_ATTEMPTS - 1) continue;
      throw err;
    }
  }
  /* istanbul ignore next -- unreachable: loop always returns or throws */
  throw new Error("failed to enqueue inbox item after retries");
}

/**
 * `queue_action`: default `kind` is `"approval"`; `"handback"` and
 * `"review"` are also accepted (the review branch needs a producer for the
 * transition table + UI review path, S-H). Synthesizes the id — callers
 * never supply one.
 */
export async function facadeQueueAction(store: InboxStore, args: unknown): Promise<QueuedResult | InvalidArgsError> {
  const common = parseQueueCommonFields(args);
  if (!common.ok) return { error: "invalid_args", message: common.message };

  const rawKind = isPlainObject(args) ? args.kind : undefined;
  let kind: InboxItemKind = "approval";
  if (rawKind !== undefined) {
    if (typeof rawKind !== "string" || !(QUEUE_KINDS as readonly string[]).includes(rawKind)) {
      return { error: "invalid_args", message: "'kind' must be one of 'approval' | 'handback' | 'review'" };
    }
    kind = rawKind as InboxItemKind;
  }

  try {
    return await enqueueQueueItem(store, kind, common.value);
  } catch (err) {
    return { error: "invalid_args", message: err instanceof Error ? err.message : String(err) };
  }
}

/** `queue_retrieval`: same args/validation as `queue_action`, but `kind` is
 *  always `"handback"` — any `kind` the caller supplies is ignored. */
export async function facadeQueueRetrieval(
  store: InboxStore,
  args: unknown,
): Promise<QueuedResult | InvalidArgsError> {
  const common = parseQueueCommonFields(args);
  if (!common.ok) return { error: "invalid_args", message: common.message };

  try {
    return await enqueueQueueItem(store, "handback", common.value);
  } catch (err) {
    return { error: "invalid_args", message: err instanceof Error ? err.message : String(err) };
  }
}

const APPROVAL_REFUSAL: HumanApprovalRequiredError = {
  error: "human_approval_required",
  message: "approval is only permitted from the local jevitate ui",
};

/** SM1: an agent can never approve over MCP. Always refuses; never touches the store. */
export function facadeApproveAction(): HumanApprovalRequiredError {
  return APPROVAL_REFUSAL;
}

/** SM1: an agent can never cancel over MCP. Always refuses; never touches the store. */
export function facadeCancelCommand(): HumanApprovalRequiredError {
  return APPROVAL_REFUSAL;
}

export async function facadeGetSiteHealth(
  store: InboxStore,
): Promise<{ ok: boolean; pending: number; oldestPendingAgeSec: number; version: string }> {
  return store.health();
}
