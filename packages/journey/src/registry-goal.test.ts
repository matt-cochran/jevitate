import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FsJourneyStore, JourneyRegistry } from "./index.js";

const rec = { version: "1", site: "example", pages: [] };
const mk = (id: string, promoted: boolean, goal: string) => ({
  metadata: { id, name: id, goal, promoted, params: [], createdAtIso: "2026-09-19T00:00:00Z" },
  recording: rec,
});

describe("JourneyRegistry.find goal terms", () => {
  it("finds a promoted journey by terms that appear only in its goal", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jr-goal-"));
    const reg = new JourneyRegistry(new FsJourneyStore(dir));
    await reg.put(mk("alpha", true, "reset the customer password") as any);
    expect((await reg.find("customer password")).map((m) => m.id)).toEqual(["alpha"]);
  });

  it("does not return an unpromoted journey whose goal matches the terms", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jr-goal-"));
    const reg = new JourneyRegistry(new FsJourneyStore(dir));
    await reg.put(mk("beta", false, "reset the customer password") as any);
    expect(await reg.find("customer password")).toEqual([]);
  });
});
