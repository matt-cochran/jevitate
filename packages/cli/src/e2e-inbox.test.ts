import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FsInboxStore } from "@jevitate/inbox";
import { facadeQueueRetrieval, facadeGetCommand } from "@jevitate/mcp-facade";
import { startUiServer, type UiServerHandle } from "./ui-api.js";

/**
 * End-to-end proof of the full HITL inbox <-> UI loop, wiring together the
 * three packages this task ships: `@jevitate/inbox` (the store),
 * `@jevitate/mcp-facade` (the agent-facing tools), and `packages/cli`'s
 * `startUiServer` (the human-facing local server) — exactly the path a real
 * `jevitate ui` run exercises:
 *
 *   agent enqueues (facadeQueueRetrieval)
 *     -> human sees it in the inbox (GET /api/inbox)
 *     -> human resumes it with input (POST /api/inbox/:id/resume)
 *     -> agent retrieves the input once, burn-after-read (facadeGetCommand)
 *     -> item is archived, no longer listed (GET /api/inbox)
 */

async function tmpDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "jevitate-e2e-inbox-"));
}

const servers: UiServerHandle[] = [];
afterEach(async () => {
  while (servers.length > 0) {
    const s = servers.pop()!;
    await s.close();
  }
});

describe("e2e: agent enqueue -> human resume via UI -> agent retrieval (burn-after-read)", () => {
  it("carries a handback item through the full inbox <-> ui loop", async () => {
    const inboxDir = await tmpDir();
    const store = new FsInboxStore(inboxDir);

    // 1. Agent enqueues a retrieval request (queue_retrieval -> kind "handback").
    const queued = await facadeQueueRetrieval(store, {
      run: "r1",
      journey: "j1",
      step: "s1",
      reason: "need the OTP",
      agent: "claude-code",
    });
    expect("id" in queued).toBe(true);
    if (!("id" in queued)) throw new Error("expected a queued result");
    const { id } = queued;

    // 2. Human's local UI server is started, and sees the item via GET /api/inbox.
    const handle = await startUiServer({ inboxDir, open: false });
    servers.push(handle);

    const listRes = await fetch(`http://127.0.0.1:${handle.port}/api/inbox`, {
      headers: { "x-jevitate-token": handle.token },
    });
    expect(listRes.status).toBe(200);
    const listBody = (await listRes.json()) as { items: Array<{ id: string; kind: string; status: string }> };
    expect(listBody.items.map((it) => it.id)).toContain(id);
    expect(listBody.items.find((it) => it.id === id)).toMatchObject({ kind: "handback", status: "pending" });

    // 3. Human resumes with input via POST /api/inbox/:id/resume { input }.
    const resumeRes = await fetch(`http://127.0.0.1:${handle.port}/api/inbox/${id}/resume`, {
      method: "POST",
      headers: { "x-jevitate-token": handle.token, "Content-Type": "application/json" },
      body: JSON.stringify({ input: "the otp is 123456" }),
    });
    expect(resumeRes.status).toBe(200);
    const resumed = (await resumeRes.json()) as { status: string };
    expect(resumed.status).toBe("resolved");

    // 4. Agent retrieves the input once — burn-after-read.
    const first = await facadeGetCommand(store, { id });
    expect("error" in first).toBe(false);
    if ("error" in first) throw new Error("expected humanInput on first read");
    expect(first.humanInput).toBe("the otp is 123456");

    const second = await facadeGetCommand(store, { id });
    expect("error" in second).toBe(false);
    if ("error" in second) throw new Error("expected an item on second read (archived, secret burned)");
    expect(second.humanInput).toBeUndefined();

    // 5. Resolved/archived item no longer shows up in the pending inbox listing.
    const finalListRes = await fetch(`http://127.0.0.1:${handle.port}/api/inbox`, {
      headers: { "x-jevitate-token": handle.token },
    });
    expect(finalListRes.status).toBe(200);
    const finalListBody = (await finalListRes.json()) as { items: Array<{ id: string }> };
    expect(finalListBody.items.map((it) => it.id)).not.toContain(id);
  });
});
