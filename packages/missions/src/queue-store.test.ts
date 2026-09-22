import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FsMissionQueueStore } from "./queue-store.js";
import type { QueuedMission } from "./schema.js";

function mkMission(id: string): QueuedMission {
  return {
    target: "demo-shop",
    goal: "verify checkout completes",
    successAssertion: { kind: "urlIncludes", text: "/checkout" },
    strategy: "goal-based",
    budget: { maxActions: 60, maxDecisions: 120, maxCandidates: 250 },
    id,
    status: "queued",
    enqueuedAtIso: "2026-09-20T00:00:00Z",
  };
}

describe("FsMissionQueueStore", () => {
  it("enqueue then get round-trips", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mqs-"));
    const store = new FsMissionQueueStore(dir);
    await store.enqueue(mkMission("m-1"));
    expect(await store.get("m-1")).toEqual(mkMission("m-1"));
  });

  it("enqueue validates QueuedMissionSchema before writing (invalid record writes nothing)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mqs-"));
    const store = new FsMissionQueueStore(dir);
    const invalid = { ...mkMission("m-2"), status: undefined } as any;
    await expect(store.enqueue(invalid)).rejects.toThrow();
    expect(existsSync(join(dir, "m-2.json"))).toBe(false);
  });

  it("list returns all queued missions", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mqs-"));
    const store = new FsMissionQueueStore(dir);
    await store.enqueue(mkMission("m-1"));
    await store.enqueue(mkMission("m-2"));
    const list = await store.list();
    expect(list.map((m) => m.id).sort()).toEqual(["m-1", "m-2"]);
  });

  it("get on a missing id returns null", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mqs-"));
    const store = new FsMissionQueueStore(dir);
    expect(await store.get("does-not-exist")).toBeNull();
  });

  it("list skips a hand-corrupted JSON file rather than throwing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mqs-"));
    const store = new FsMissionQueueStore(dir);
    await store.enqueue(mkMission("m-1"));
    writeFileSync(join(dir, "corrupt.json"), "{not valid json", "utf8");
    const list = await store.list();
    expect(list.map((m) => m.id)).toEqual(["m-1"]);
  });
});
