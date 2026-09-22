import { describe, it, expect } from "vitest";
import { mkdtemp, readFile, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileAtomic } from "./atomic.js";

describe("writeFileAtomic", () => {
  it("writes the full content and leaves no temp file behind", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jevitate-atomic-"));
    const p = join(dir, "x.json");
    await writeFileAtomic(p, '{"a":1}', 0o600);
    expect(await readFile(p, "utf8")).toBe('{"a":1}');
    expect((await readdir(dir)).filter((f) => f !== "x.json")).toEqual([]);
  });

  it("applies the given mode", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jevitate-atomic-"));
    const p = join(dir, "y.json");
    await writeFileAtomic(p, "{}", 0o600);
    expect((await stat(p)).mode & 0o777).toBe(0o600);
  });

  it("overwrites an existing file atomically", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jevitate-atomic-"));
    const p = join(dir, "z.json");
    await writeFileAtomic(p, "first", 0o600);
    await writeFileAtomic(p, "second", 0o600);
    expect(await readFile(p, "utf8")).toBe("second");
  });

  it("rejects and leaves no temp file behind when the write fails (C-D)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jevitate-atomic-"));
    // target dir does not exist → open() throws → catch path runs
    await expect(writeFileAtomic(join(dir, "missing", "z.json"), "x", 0o600)).rejects.toThrow();
    expect((await readdir(dir)).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });
});
