import { describe, it, expect } from "vitest";
import { mkdtemp, readFile, readdir, writeFile, mkdir, stat, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InboxItem } from "./types.js";
import { asSecret, revealSecret } from "./types.js";
import {
  FsInboxStore,
  InboxIdConflictError,
  InboxItemAlreadyResolvedError,
  InboxItemNotFoundError,
  HumanApprovalRequiredError,
  IllegalTransitionError,
} from "./store.js";

async function tmpDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "jevitate-inbox-store-"));
}

function baseItem(overrides: Partial<InboxItem> = {}): InboxItem {
  return {
    id: "item-1",
    kind: "approval",
    status: "pending",
    run: "r1",
    journey: "j1",
    step: "s1",
    reason: "please approve",
    agent: "claude-code",
    hasScreenshot: false,
    thread: [],
    createdAt: new Date().toISOString(),
    ttlSec: 3600,
    ...overrides,
  } as InboxItem;
}

describe("FsInboxStore.enqueue / get round-trip", () => {
  it("writes then reads back the exact item", async () => {
    const dir = await tmpDir();
    const store = new FsInboxStore(dir);
    const item = baseItem();
    await store.enqueue(item);
    const got = await store.get(item.id);
    expect(got).toEqual(item);
    expect(await readFile(join(dir, `${item.id}.json`), "utf8")).toContain(item.id);
  });

  it("rejects duplicate id with InboxIdConflictError and does not clobber the original", async () => {
    const dir = await tmpDir();
    const store = new FsInboxStore(dir);
    const item = baseItem();
    await store.enqueue(item);
    const dup = baseItem({ reason: "different reason" });
    await expect(store.enqueue(dup)).rejects.toThrow(InboxIdConflictError);
    const got = await store.get(item.id);
    expect(got!.reason).toBe("please approve");
  });
});

describe("FsInboxStore.getSummaries", () => {
  it("returns pending-only, newest-first, with no secret fields", async () => {
    const dir = await tmpDir();
    const store = new FsInboxStore(dir);
    const older = baseItem({ id: "older", createdAt: new Date(Date.now() - 10_000).toISOString() });
    const newer = baseItem({ id: "newer", createdAt: new Date().toISOString(), humanInput: asSecret("shh") });
    await store.enqueue(older);
    await store.enqueue(newer);
    // Resolve one to terminal so it should be excluded (move to archive)
    const terminal = baseItem({ id: "terminal", kind: "approval", createdAt: new Date().toISOString() });
    await store.enqueue(terminal);
    await store.resolve("terminal", { channel: "human", action: "approve" });

    const summaries = await store.getSummaries();
    expect(summaries.map((s) => s.id)).toEqual(["newer", "older"]);
    for (const s of summaries) {
      expect((s as Record<string, unknown>).humanInput).toBeUndefined();
    }
  });
});

describe("FsInboxStore.resolve concurrency (S-E)", () => {
  it("two store instances resolving the same id concurrently: exactly one succeeds", async () => {
    const dir = await tmpDir();
    const storeA = new FsInboxStore(dir);
    const storeB = new FsInboxStore(dir);
    const item = baseItem({ id: "race", kind: "approval" });
    await storeA.enqueue(item);

    const results = await Promise.allSettled([
      storeA.resolve("race", { channel: "human", action: "approve" }),
      storeB.resolve("race", { channel: "human", action: "approve" }),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(InboxItemAlreadyResolvedError);
  });
});

describe("FsInboxStore.resolve channel gating (SM1)", () => {
  it("agent channel can never resolve", async () => {
    const dir = await tmpDir();
    const store = new FsInboxStore(dir);
    const item = baseItem({ id: "gate", kind: "approval" });
    await store.enqueue(item);
    await expect(store.resolve("gate", { channel: "agent", action: "approve" })).rejects.toThrow(
      HumanApprovalRequiredError,
    );
    // item remains pending / untouched
    const got = await store.get("gate");
    expect(got!.status).toBe("pending");
  });

  it("rejects an illegal transition (approval + resume)", async () => {
    const dir = await tmpDir();
    const store = new FsInboxStore(dir);
    const item = baseItem({ id: "illegal", kind: "approval" });
    await store.enqueue(item);
    await expect(store.resolve("illegal", { channel: "human", action: "resume" })).rejects.toThrow(
      IllegalTransitionError,
    );
  });

  it("resolving a not-found id throws InboxItemNotFoundError", async () => {
    const dir = await tmpDir();
    const store = new FsInboxStore(dir);
    await expect(store.resolve("nope", { channel: "human", action: "approve" })).rejects.toThrow(
      InboxItemNotFoundError,
    );
  });

  it("resolving an already-resolved id throws InboxItemAlreadyResolvedError", async () => {
    const dir = await tmpDir();
    const store = new FsInboxStore(dir);
    const item = baseItem({ id: "already", kind: "approval" });
    await store.enqueue(item);
    await store.resolve("already", { channel: "human", action: "approve" });
    await expect(store.resolve("already", { channel: "human", action: "approve" })).rejects.toThrow(
      InboxItemAlreadyResolvedError,
    );
  });
});

describe("FsInboxStore.resolve resume-with-input redaction", () => {
  it("stores humanInput but appends only the redacted marker to the thread", async () => {
    const dir = await tmpDir();
    const store = new FsInboxStore(dir);
    const item = baseItem({ id: "handback-1", kind: "handback" });
    await store.enqueue(item);
    const resolved = await store.resolve("handback-1", {
      channel: "human",
      action: "resume",
      input: "super-secret-value",
    });
    expect(resolved.status).toBe("resolved");
    expect(revealSecret(resolved.humanInput!)).toBe("super-secret-value");
    const thread = resolved.thread;
    expect(thread.length).toBe(1);
    expect(thread[0]).toMatchObject({ author: "human", text: "human provided input" });
    expect(JSON.stringify(thread)).not.toContain("super-secret-value");
    // On disk archive file also must not contain the raw value in the thread portion; but humanInput itself IS stored (until burned).
    const archived = JSON.parse(await readFile(join(dir, "archive", "handback-1.json"), "utf8"));
    expect(archived.thread[0].text).toBe("human provided input");
  });
});

describe("FsInboxStore.getForAgent burn-after-read (SM3)", () => {
  it("returns humanInput once, then nulled on a second call, staying in archive", async () => {
    const dir = await tmpDir();
    const store = new FsInboxStore(dir);
    const item = baseItem({ id: "burn-1", kind: "handback" });
    await store.enqueue(item);
    await store.resolve("burn-1", { channel: "human", action: "resume", input: "the-secret" });

    const first = await store.getForAgent("burn-1");
    expect(first).not.toBeNull();
    expect(revealSecret(first!.humanInput!)).toBe("the-secret");
    expect(first!.secretConsumedAt).toBeDefined();

    const second = await store.getForAgent("burn-1");
    expect(second).not.toBeNull();
    expect(second!.humanInput).toBeUndefined();

    // still archived, not resurrected to hot
    await expect(stat(join(dir, "burn-1.json"))).rejects.toThrow();
    await expect(stat(join(dir, "archive", "burn-1.json"))).resolves.toBeDefined();
  });

  it("getForAgent on a still-pending item with no humanInput just returns it unchanged", async () => {
    const dir = await tmpDir();
    const store = new FsInboxStore(dir);
    const item = baseItem({ id: "pending-1", kind: "approval" });
    await store.enqueue(item);
    const got = await store.getForAgent("pending-1");
    expect(got!.status).toBe("pending");
    expect(got!.humanInput).toBeUndefined();
  });
});

describe("FsInboxStore concurrent reader never sees a partial file", () => {
  it("a reader racing a large write always sees valid JSON or ENOENT — never a truncated parse error", async () => {
    const dir = await tmpDir();
    const store = new FsInboxStore(dir);
    const bigReason = "x".repeat(200_000);
    const item = baseItem({ id: "big-1", reason: bigReason });
    await store.enqueue(item);

    let sawError = false;
    const reader = (async () => {
      for (let i = 0; i < 50; i++) {
        try {
          const got = await store.get("big-1");
          if (got) expect(got.reason.length === bigReason.length || got.reason === "updated").toBe(true);
        } catch {
          sawError = true;
        }
      }
    })();

    const writer = (async () => {
      for (let i = 0; i < 10; i++) {
        // appendThread performs an atomic write of the whole item under lock
        await store.appendThread("big-1", { author: "human", text: `note-${i}`, at: new Date().toISOString() });
      }
    })();

    await Promise.all([reader, writer]);
    expect(sawError).toBe(false);
  });
});

describe("FsInboxStore.appendThread", () => {
  it("stores caller text verbatim and refuses on a terminal item", async () => {
    const dir = await tmpDir();
    const store = new FsInboxStore(dir);
    const item = baseItem({ id: "thread-1", kind: "approval" });
    await store.enqueue(item);
    const updated = await store.appendThread("thread-1", { author: "agent", text: "raw text here", at: "t1" });
    expect(updated.thread.at(-1)).toMatchObject({ author: "agent", text: "raw text here" });

    await store.resolve("thread-1", { channel: "human", action: "approve" });
    await expect(
      store.appendThread("thread-1", { author: "agent", text: "too late", at: "t2" }),
    ).rejects.toThrow(InboxItemAlreadyResolvedError);
  });
});

describe("FsInboxStore.sweepExpired", () => {
  it("expires items past their ttl, nulls humanInput, and archives them", async () => {
    const dir = await tmpDir();
    const store = new FsInboxStore(dir);
    const oldCreated = new Date(Date.now() - 100_000).toISOString();
    const expiring = baseItem({ id: "expire-1", createdAt: oldCreated, ttlSec: 10, humanInput: asSecret("s") });
    const fresh = baseItem({ id: "fresh-1", createdAt: new Date().toISOString(), ttlSec: 3600 });
    await store.enqueue(expiring);
    await store.enqueue(fresh);

    const count = await store.sweepExpired();
    expect(count).toBe(1);

    const archived = JSON.parse(await readFile(join(dir, "archive", "expire-1.json"), "utf8"));
    expect(archived.status).toBe("expired");
    expect(archived.humanInput).toBeUndefined();

    await expect(stat(join(dir, "expire-1.json"))).rejects.toThrow();
    const summaries = await store.getSummaries();
    expect(summaries.map((s) => s.id)).toEqual(["fresh-1"]);
  });
});

describe("FsInboxStore.health", () => {
  it("returns counts without reading item bodies, ignoring archive/screenshots/lock/tmp/dotfiles", async () => {
    const dir = await tmpDir();
    const store = new FsInboxStore(dir, "test-version");
    // health uses file mtimes, not the createdAt field inside the item —
    // so age here reflects wall-clock write time, not a backdated createdAt.
    await store.enqueue(baseItem({ id: "h1", createdAt: new Date().toISOString() }));
    await store.enqueue(baseItem({ id: "h2", createdAt: new Date().toISOString() }));
    const oldMtime = new Date(Date.now() - 50_000);
    await utimes(join(dir, "h1.json"), oldMtime, oldMtime);

    // Plant decoys that health must ignore.
    await mkdir(join(dir, "archive"), { recursive: true });
    await writeFile(join(dir, "archive", "decoy.json"), "not json {{{");
    await mkdir(join(dir, "screenshots"), { recursive: true });
    await writeFile(join(dir, "screenshots", "h1.png"), "binary");
    await writeFile(join(dir, "stray.lock"), "");
    await writeFile(join(dir, "stray.tmp"), "");
    await writeFile(join(dir, ".hidden.json"), "not json {{{");
    // A malformed hot file must not crash health — health never opens item
    // bodies, so it cannot tell this .json file is malformed and counts it
    // by name alone, same as any other hot file.
    await writeFile(join(dir, "bad.json"), "not valid json {{{");

    const health = await store.health();
    expect(health.ok).toBe(true);
    expect(health.pending).toBe(3);
    expect(health.oldestPendingAgeSec).toBeGreaterThanOrEqual(45);
    expect(health.version).toBe("test-version");
  });
});

describe("FsInboxStore corrupt-file handling (S-G)", () => {
  it("get() throws on a malformed hot file (fail-closed)", async () => {
    const dir = await tmpDir();
    const store = new FsInboxStore(dir);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "corrupt-1.json"), "{ this is not valid json");
    await expect(store.get("corrupt-1")).rejects.toThrow();
  });

  it("getSummaries() defensively skips a malformed hot file", async () => {
    const dir = await tmpDir();
    const store = new FsInboxStore(dir);
    await store.enqueue(baseItem({ id: "good-1" }));
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "corrupt-2.json"), "{ this is not valid json");
    const summaries = await store.getSummaries();
    expect(summaries.map((s) => s.id)).toEqual(["good-1"]);
  });

  it(".strict() rejects a tampered file — get() throws, getSummaries() skips it", async () => {
    const dir = await tmpDir();
    const store = new FsInboxStore(dir);
    const item = baseItem({ id: "tampered-1" });
    await store.enqueue(item);
    const onDisk = JSON.parse(await readFile(join(dir, "tampered-1.json"), "utf8"));
    onDisk.injectedField = "should not be here";
    await writeFile(join(dir, "tampered-1.json"), JSON.stringify(onDisk));

    await expect(store.get("tampered-1")).rejects.toThrow();
    const summaries = await store.getSummaries();
    expect(summaries.map((s) => s.id)).toEqual([]);
  });
});

describe("FsInboxStore.get archive lookup", () => {
  it("finds a terminal item in archive/ and returns null for a truly unknown id", async () => {
    const dir = await tmpDir();
    const store = new FsInboxStore(dir);
    const item = baseItem({ id: "arch-1", kind: "approval" });
    await store.enqueue(item);
    await store.resolve("arch-1", { channel: "human", action: "approve" });
    const got = await store.get("arch-1");
    expect(got!.status).toBe("approved");
    expect(await store.get("does-not-exist")).toBeNull();
  });
});
