import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Recording } from "./schema.js";
import { FsRecordingStore } from "./store.js";

function makeRecording(overrides: Partial<Recording> = {}): Recording {
  return {
    version: "1.0",
    site: "https://example.com",
    pages: [
      {
        url: "https://example.com",
        steps: [
          {
            step: {
              kind: "navigate",
              url: "https://example.com",
              expect: { kind: "urlIncludes", text: "example.com" },
            },
          },
        ],
      },
    ],
    ...overrides,
  };
}

describe("FsRecordingStore", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "jevitate-recording-store-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("round-trips put/get", async () => {
    const store = new FsRecordingStore(dir);
    const rec = makeRecording();
    await store.put("rec-1", rec);

    const got = await store.get("rec-1");
    expect(got).toEqual(rec);
  });

  it("returns null from get for a nonexistent id", async () => {
    const store = new FsRecordingStore(dir);
    expect(await store.get("does-not-exist")).toBeNull();
  });

  it("prunes a recording so get then returns null", async () => {
    const store = new FsRecordingStore(dir);
    await store.put("rec-1", makeRecording());
    await store.prune("rec-1");
    expect(await store.get("rec-1")).toBeNull();
  });

  it("prune is a no-op (does not throw) for a nonexistent id", async () => {
    const store = new FsRecordingStore(dir);
    await expect(store.prune("nope")).resolves.toBeUndefined();
  });

  it("writes the file with user-only permissions (0o600)", async () => {
    const store = new FsRecordingStore(dir);
    await store.put("rec-1", makeRecording());
    const st = await stat(join(dir, "rec-1.json"));
    expect(st.mode & 0o777).toBe(0o600);
  });

  it("persists a savedAtIso wrapper distinct from the bare Recording shape", async () => {
    const store = new FsRecordingStore(dir);
    await store.put("rec-1", makeRecording());
    const list = await store.list();
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe("rec-1");
    expect(typeof list[0].savedAtIso).toBe("string");
    expect(() => new Date(list[0].savedAtIso).toISOString()).not.toThrow();
  });

  it("rejects an invalid Recording (fail-closed, does not write to disk)", async () => {
    const store = new FsRecordingStore(dir);
    const invalid = { not: "a recording" } as unknown as Recording;
    await expect(store.put("bad", invalid)).rejects.toThrow();
    expect(await store.get("bad")).toBeNull();
  });

  describe("path-traversal defense", () => {
    it.each([
      "../escape",
      "..\\escape",
      "a/b",
      "a\\b",
      "..",
      "/etc/passwd",
    ])("rejects id %j on put", async (id) => {
      const store = new FsRecordingStore(dir);
      await expect(store.put(id, makeRecording())).rejects.toThrow();
    });

    it("rejects a traversal id on get", async () => {
      const store = new FsRecordingStore(dir);
      await expect(store.get("../escape")).rejects.toThrow();
    });

    it("rejects a traversal id on prune", async () => {
      const store = new FsRecordingStore(dir);
      await expect(store.prune("../escape")).rejects.toThrow();
    });
  });

  it("enforces a size cap on the serialized JSON, throwing rather than truncating", async () => {
    const store = new FsRecordingStore(dir, { maxBytes: 200 });
    const big = makeRecording({ intent: "x".repeat(10_000) });
    await expect(store.put("too-big", big)).rejects.toThrow();
    expect(await store.get("too-big")).toBeNull();
  });

  it("allows a recording within a custom maxBytes cap", async () => {
    const store = new FsRecordingStore(dir, { maxBytes: 1024 * 1024 });
    await expect(store.put("ok", makeRecording())).resolves.toBeUndefined();
  });

  it("list() skips a corrupt/unparseable file rather than throwing", async () => {
    const store = new FsRecordingStore(dir);
    await store.put("good", makeRecording());
    await writeFile(join(dir, "corrupt.json"), "{not valid json", {
      mode: 0o600,
    });

    const list = await store.list();
    expect(list.map((e) => e.id)).toEqual(["good"]);
  });

  it("list() returns an empty array for an empty/non-existent store dir", async () => {
    const store = new FsRecordingStore(join(dir, "fresh-subdir"));
    expect(await store.list()).toEqual([]);
  });

  describe("gcOlderThan", () => {
    it("removes entries saved before the cutoff and keeps fresher ones", async () => {
      const store = new FsRecordingStore(dir);
      await store.put("old", makeRecording());
      await store.put("new", makeRecording());

      // Rewrite "old"'s wrapper with a manufactured stale savedAtIso so we
      // don't depend on real wall-clock time passing between two puts.
      const oldPath = join(dir, "old.json");
      const raw = JSON.parse(await readFile(oldPath, "utf8"));
      raw.savedAtIso = "2000-01-01T00:00:00.000Z";
      await writeFile(oldPath, JSON.stringify(raw), { mode: 0o600 });

      const removed = await store.gcOlderThan("2020-01-01T00:00:00.000Z");
      expect(removed).toBe(1);

      const remaining = await store.list();
      expect(remaining.map((e) => e.id)).toEqual(["new"]);
    });

    it("returns 0 when nothing is older than the cutoff", async () => {
      const store = new FsRecordingStore(dir);
      await store.put("new", makeRecording());
      const removed = await store.gcOlderThan("2000-01-01T00:00:00.000Z");
      expect(removed).toBe(0);
      expect(await store.list()).toHaveLength(1);
    });
  });
});
