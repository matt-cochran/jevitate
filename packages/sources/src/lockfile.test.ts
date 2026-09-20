import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readLock, writeLock, JevitateLockSchema, DEFAULT_LOCK_PATH } from "./lockfile.js";

describe("jevitate.lock", () => {
  it("round-trips and is deterministic in order", async () => {
    const p = join(mkdtempSync(join(tmpdir(), "lock-")), "jevitate.lock");
    await writeLock(p, {
      version: 1,
      sources: [
        { name: "gmail", gitUrl: "https://github.com/x/jevitate-gmail", pinnedCommit: "a".repeat(40) },
      ],
    });
    expect((await readLock(p)).sources[0].name).toBe("gmail");
  });

  it("sorts sources by name for deterministic diffs", async () => {
    const p = join(mkdtempSync(join(tmpdir(), "lock-")), "jevitate.lock");
    await writeLock(p, {
      version: 1,
      sources: [
        { name: "zeta", gitUrl: "https://h/z", pinnedCommit: "b".repeat(40) },
        { name: "alpha", gitUrl: "https://h/a", pinnedCommit: "a".repeat(40) },
      ],
    });
    const lock = await readLock(p);
    expect(lock.sources.map((s) => s.name)).toEqual(["alpha", "zeta"]);
  });

  it("returns empty for a missing lock but THROWS on a malformed one", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lock-"));
    expect((await readLock(join(dir, "nope.lock"))).sources).toEqual([]);
    writeFileSync(join(dir, "bad.lock"), "{ not json");
    await expect(readLock(join(dir, "bad.lock"))).rejects.toThrow();
  });

  it("rejects a pin that is not a hex commit", () => {
    expect(() =>
      JevitateLockSchema.parse({
        version: 1,
        sources: [{ name: "x", gitUrl: "https://h/x", pinnedCommit: "latest" }],
      }),
    ).toThrow();
  });

  it("rejects a source name with a path-traversal shape", () => {
    expect(() =>
      JevitateLockSchema.parse({
        version: 1,
        sources: [{ name: "../evil", gitUrl: "https://h/x", pinnedCommit: "a".repeat(40) }],
      }),
    ).toThrow();
  });

  it("DEFAULT_LOCK_PATH resolves under cwd", () => {
    expect(DEFAULT_LOCK_PATH("/tmp/proj")).toBe(join("/tmp/proj", "jevitate.lock"));
  });
});
