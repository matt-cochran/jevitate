import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FsMissionTargetStore } from "./target-store.js";
import type { MissionTarget } from "./schema.js";

function mkTarget(id: string, promoted: boolean): MissionTarget {
  return {
    id,
    name: id,
    authorizedOrigin: "https://demo.example.com",
    baseUrl: "https://demo.example.com",
    promoted,
    createdAtIso: "2026-09-20T00:00:00Z",
  };
}

describe("FsMissionTargetStore", () => {
  it("put then get round-trips", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mts-"));
    const store = new FsMissionTargetStore(dir);
    await store.put(mkTarget("demo-shop", true));
    expect(await store.get("demo-shop")).toEqual(mkTarget("demo-shop", true));
  });

  it("get on a missing id returns null", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mts-"));
    const store = new FsMissionTargetStore(dir);
    expect(await store.get("does-not-exist")).toBeNull();
  });

  it("put rejects an invalid target before writing (file never created)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mts-"));
    const store = new FsMissionTargetStore(dir);
    const invalid = { ...mkTarget("bad-id/../etc", true) };
    await expect(store.put(invalid as any)).rejects.toThrow();
    expect(existsSync(join(dir, "bad-id/../etc.json"))).toBe(false);
  });

  it("list skips a hand-corrupted JSON file rather than throwing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mts-"));
    const store = new FsMissionTargetStore(dir);
    await store.put(mkTarget("good-target", true));
    writeFileSync(join(dir, "corrupt.json"), "{not valid json", "utf8");
    const list = await store.list();
    expect(list.map((t) => t.id)).toEqual(["good-target"]);
  });
});
