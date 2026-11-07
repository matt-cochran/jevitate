import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contentHash } from "@jevitate/domain";
import { FsJourneyStore } from "./store.js";
import type { Journey } from "./journey.js";

vi.mock("node:fs/promises", async (importOriginal) => ({ ...await importOriginal<typeof import("node:fs/promises")>() }));

let dir: string;
let store: FsJourneyStore;
let before: Journey;
beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), "jev-atomic-store-")); store = new FsJourneyStore(dir);
  await store.put({ metadata: { id: "sample", name: "Before", params: [], promoted: false, createdAtIso: "2026-11-07T00:00:00Z" }, recording: { version: "1", site: "https://example.test", pages: [{ url: "/", steps: [{ step: { kind: "navigate", url: "/", expect: { kind: "urlIncludes", text: "/" } } }] }] } });
  before = (await store.getGuarded("sample"))!;
});
afterEach(async () => { vi.restoreAllMocks(); await fs.rm(dir, { recursive: true, force: true }); });

describe("guarded atomic Journey transaction writes", () => {
  it("keeps the complete old Journey when a sibling temporary write fails halfway", async () => {
    const original = fs.open;
    vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await original(...args);
      if (String(args[0]).endsWith(".tmp")) {
        const write = handle.writeFile.bind(handle);
        vi.spyOn(handle, "writeFile").mockImplementationOnce(async () => { await write("{partial"); throw new Error("injected disk write failure"); });
      }
      return handle;
    });
    const next = { ...before, metadata: { ...before.metadata, name: "After" } };
    await expect(store.putGuarded(next, contentHash(before))).rejects.toThrow("injected disk write failure");
    expect(await store.getGuarded("sample")).toEqual(before);
    expect((await fs.readdir(dir)).filter((p) => p.endsWith(".tmp"))).toEqual([]);
  });

  it("refuses a changed preimage without losing the concurrent writer", async () => {
    await store.put({ ...before, metadata: { ...before.metadata, name: "Concurrent" } });
    await expect(store.putGuarded({ ...before, metadata: { ...before.metadata, name: "After" } }, contentHash(before))).rejects.toThrow("preimage changed");
    expect((await store.getGuarded("sample"))!.metadata.name).toBe("Concurrent");
  });

  it("preserves schema and native normalization across atomic replacement", async () => {
    const candidate = { ...before, metadata: { ...before.metadata, name: "After" } };
    const expected = store.normalizeForWrite(candidate);
    expect(await store.putGuarded(candidate, contentHash(before))).toEqual(expected);
    expect(await store.getGuarded("sample")).toEqual(expected);
    expect((await fs.readdir(dir)).filter((p) => p.endsWith(".tmp"))).toEqual([]);
  });

  it("refuses namespace-directory symlinks", async () => {
    await fs.symlink(dir, join(dir, "alias"));
    await expect(store.getGuarded("alias/sample")).rejects.toThrow("Unsafe Journey transaction directory");
  });
});

it("refuses a named pipe before opening or reading it", async () => {
  const path = join(dir, "sample.json");
  const fifo = await fs.lstat(path);
  vi.spyOn(fifo, "isFile").mockReturnValue(false);
  vi.spyOn(fifo, "isFIFO").mockReturnValue(true);
  const lstat = fs.lstat;
  vi.spyOn(fs, "lstat").mockImplementation(async (...args) => String(args[0]) === path ? fifo : lstat(...args));
  const open = vi.spyOn(fs, "open");
  await expect(store.getGuarded("sample")).rejects.toThrow("Unsafe Journey transaction file");
  expect(open).not.toHaveBeenCalled();
});
