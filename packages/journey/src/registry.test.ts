import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FsJourneyStore, JourneyRegistry } from "./index.js";

const rec = { version: "1", site: "example", pages: [] };
const mk = (id: string, promoted: boolean) => ({
  metadata: { id, name: id, promoted, params: [], createdAtIso: "2026-09-19T00:00:00Z" }, recording: rec,
});

describe("JourneyRegistry.find", () => {
  it("returns only promoted journeys and hides unpromoted ones", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jr-"));
    const reg = new JourneyRegistry(new FsJourneyStore(dir));
    await reg.put(mk("login", false) as any);
    await reg.put(mk("checkout", true) as any);
    const all = await reg.find("");
    expect(all.map((m) => m.id)).toEqual(["checkout"]);
    expect(await reg.find("login")).toEqual([]); // unpromoted stays invisible
  });
  it("promote() flips the flag so a journey becomes discoverable", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jr-"));
    const reg = new JourneyRegistry(new FsJourneyStore(dir));
    await reg.put(mk("login", false) as any);
    await reg.promote("login");
    expect((await reg.find("log")).map((m) => m.id)).toEqual(["login"]);
  });
});
