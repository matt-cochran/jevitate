import { describe, it, expect } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FsInboxStore } from "@jevitate/inbox";
import {
  facadeListIncoming,
  facadeGetCommand,
  facadeGetThread,
  facadeQueueAction,
  facadeQueueRetrieval,
  facadeApproveAction,
  facadeCancelCommand,
  facadeGetSiteHealth,
} from "./inbox-tools.js";

async function tmpDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "jevitate-mcp-facade-inbox-"));
}

function baseArgs(overrides: Record<string, unknown> = {}) {
  return { run: "r1", journey: "j1", step: "s1", reason: "please look", agent: "claude-code", ...overrides };
}

describe("facadeListIncoming", () => {
  it("returns an empty list for an empty store", async () => {
    const store = new FsInboxStore(await tmpDir());
    expect(await facadeListIncoming(store)).toEqual({ items: [] });
  });

  it("returns pending summaries", async () => {
    const store = new FsInboxStore(await tmpDir());
    await facadeQueueAction(store, baseArgs());
    const result = await facadeListIncoming(store);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      run: "r1", journey: "j1", step: "s1", agent: "claude-code", kind: "approval", status: "pending",
    });
  });
});

describe("facadeGetCommand", () => {
  it("returns invalid_args when id is missing", async () => {
    const store = new FsInboxStore(await tmpDir());
    const result = await facadeGetCommand(store, {});
    expect(result).toEqual({ error: "invalid_args", message: expect.any(String) });
  });

  it("returns invalid_args when id is not a safe inbox id", async () => {
    const store = new FsInboxStore(await tmpDir());
    const result = await facadeGetCommand(store, { id: "../etc/passwd" });
    expect(result).toEqual({ error: "invalid_args", message: expect.any(String) });
  });

  it("returns not_found for a missing item", async () => {
    const store = new FsInboxStore(await tmpDir());
    expect(await facadeGetCommand(store, { id: "does-not-exist" })).toEqual({ error: "not_found" });
  });

  it("returns the still-pending item with no resolution (agent poll contract)", async () => {
    const store = new FsInboxStore(await tmpDir());
    const queued = (await facadeQueueAction(store, baseArgs())) as { id: string };
    const result = await facadeGetCommand(store, { id: queued.id });
    expect(result).toMatchObject({ id: queued.id, status: "pending" });
    expect((result as Record<string, unknown>).resolution).toBeUndefined();
  });
});

describe("facadeGetThread", () => {
  it("returns invalid_args for a non-string id", async () => {
    const store = new FsInboxStore(await tmpDir());
    expect(await facadeGetThread(store, { id: 5 })).toEqual({ error: "invalid_args", message: expect.any(String) });
  });

  it("returns not_found for a missing item", async () => {
    const store = new FsInboxStore(await tmpDir());
    expect(await facadeGetThread(store, { id: "does-not-exist" })).toEqual({ error: "not_found" });
  });

  it("returns the redacted thread entries", async () => {
    const store = new FsInboxStore(await tmpDir());
    const queued = (await facadeQueueAction(store, baseArgs())) as { id: string };
    await store.appendThread(queued.id, { author: "agent", text: "hello", at: new Date().toISOString() });
    const result = await facadeGetThread(store, { id: queued.id });
    expect(result).toEqual({ thread: [{ author: "agent", text: "hello", at: expect.any(String) }] });
  });
});

describe("facadeQueueAction", () => {
  it("enqueues with default kind 'approval' and a synthesized safe id", async () => {
    const store = new FsInboxStore(await tmpDir());
    const result = (await facadeQueueAction(store, baseArgs())) as { id: string; status: string };
    expect(result.status).toBe("pending");
    expect(result.id).toMatch(/^[a-z0-9][a-z0-9_-]{0,63}$/);
    const stored = await store.get(result.id);
    expect(stored?.kind).toBe("approval");
  });

  it("accepts kind 'review'", async () => {
    const store = new FsInboxStore(await tmpDir());
    const result = (await facadeQueueAction(store, baseArgs({ kind: "review" }))) as { id: string };
    const stored = await store.get(result.id);
    expect(stored?.kind).toBe("review");
  });

  it("accepts targetUrl/hasScreenshot/findings", async () => {
    const store = new FsInboxStore(await tmpDir());
    const result = (await facadeQueueAction(
      store,
      baseArgs({ targetUrl: "https://example.com", hasScreenshot: true, findings: [{ id: "f1", title: "issue", severity: "high" }] }),
    )) as { id: string };
    const stored = await store.get(result.id);
    expect(stored?.targetUrl).toBe("https://example.com");
    expect(stored?.hasScreenshot).toBe(true);
    expect(stored?.findings).toEqual([{ id: "f1", title: "issue", severity: "high" }]);
  });

  it("returns invalid_args when a required field is missing", async () => {
    const store = new FsInboxStore(await tmpDir());
    const { agent: _omit, ...rest } = baseArgs();
    const result = await facadeQueueAction(store, rest);
    expect(result).toEqual({ error: "invalid_args", message: expect.any(String) });
  });

  it("returns invalid_args for an unknown kind", async () => {
    const store = new FsInboxStore(await tmpDir());
    const result = await facadeQueueAction(store, baseArgs({ kind: "bogus" }));
    expect(result).toEqual({ error: "invalid_args", message: expect.any(String) });
  });

  it("never throws on malformed args", async () => {
    const store = new FsInboxStore(await tmpDir());
    await expect(facadeQueueAction(store, null)).resolves.toEqual({ error: "invalid_args", message: expect.any(String) });
    await expect(facadeQueueAction(store, "nope")).resolves.toEqual({ error: "invalid_args", message: expect.any(String) });
  });
});

describe("facadeQueueRetrieval", () => {
  it("always enqueues kind 'handback' regardless of a supplied kind", async () => {
    const store = new FsInboxStore(await tmpDir());
    const result = (await facadeQueueRetrieval(store, baseArgs({ reason: "need input" }))) as { id: string; status: string };
    expect(result.status).toBe("pending");
    const stored = await store.get(result.id);
    expect(stored?.kind).toBe("handback");
  });

  it("returns invalid_args when a required field is missing", async () => {
    const store = new FsInboxStore(await tmpDir());
    const { run: _omit, ...rest } = baseArgs();
    const result = await facadeQueueRetrieval(store, rest);
    expect(result).toEqual({ error: "invalid_args", message: expect.any(String) });
  });
});

describe("facadeApproveAction / facadeCancelCommand (SM1: agent can never approve/cancel)", () => {
  it("facadeApproveAction always refuses", () => {
    expect(facadeApproveAction()).toEqual({
      error: "human_approval_required",
      message: "approval is only permitted from the local jevitate ui",
    });
  });

  it("facadeCancelCommand always refuses", () => {
    expect(facadeCancelCommand()).toEqual({
      error: "human_approval_required",
      message: "approval is only permitted from the local jevitate ui",
    });
  });
});

describe("facadeGetSiteHealth", () => {
  it("reports pending counts from the store", async () => {
    const store = new FsInboxStore(await tmpDir());
    expect(await facadeGetSiteHealth(store)).toMatchObject({ ok: true, pending: 0 });
    await facadeQueueAction(store, baseArgs());
    expect(await facadeGetSiteHealth(store)).toMatchObject({ ok: true, pending: 1 });
  });
});

describe("secret-projection invariant", () => {
  it("never leaks a resolved human secret via list/health; only get_command returns it, once", async () => {
    const store = new FsInboxStore(await tmpDir());
    const SECRET = "s3cr3t-onetime-token-xyz";

    // A decoy pending item so list/health have real content alongside the
    // resolved-with-secret item below.
    await facadeQueueAction(store, baseArgs({ run: "decoy" }));

    const retrieval = (await facadeQueueRetrieval(store, baseArgs({ run: "r2", reason: "need creds" }))) as { id: string };
    await store.resolve(retrieval.id, { channel: "human", action: "resume", input: SECRET });

    const listJson = JSON.stringify(await facadeListIncoming(store));
    expect(listJson).not.toContain(SECRET);

    const healthJson = JSON.stringify(await facadeGetSiteHealth(store));
    expect(healthJson).not.toContain(SECRET);

    const first = await facadeGetCommand(store, { id: retrieval.id });
    expect(JSON.stringify(first)).toContain(SECRET);

    const second = await facadeGetCommand(store, { id: retrieval.id });
    expect(JSON.stringify(second)).not.toContain(SECRET);
  });
});
