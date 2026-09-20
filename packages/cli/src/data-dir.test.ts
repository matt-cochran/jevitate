import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { resolveDataDir } from "./data-dir.js";

const homedir = () => "/home/u";

describe("resolveDataDir (D8: ~/.doit -> ~/.jevitate, non-orphaning fallback)", () => {
  it("prefers ~/.jevitate/<segments> when it already exists", () => {
    const newPath = join("/home/u", ".jevitate", "db.sqlite");
    const oldPath = join("/home/u", ".doit", "db.sqlite");
    const exists = (p: string) => p === newPath || p === oldPath;
    expect(resolveDataDir(["db.sqlite"], { exists, homedir })).toBe(newPath);
  });

  it("falls back to ~/.doit/<segments> when only the old path exists", () => {
    const oldPath = join("/home/u", ".doit", "journeys");
    const exists = (p: string) => p === oldPath;
    expect(resolveDataDir(["journeys"], { exists, homedir })).toBe(oldPath);
  });

  it("defaults to ~/.jevitate/<segments> when neither exists (fresh install)", () => {
    const newPath = join("/home/u", ".jevitate", "trust");
    expect(resolveDataDir(["trust"], { exists: () => false, homedir })).toBe(newPath);
  });

  it("joins multiple segments (nested dirs, e.g. trust/acks)", () => {
    const oldPath = join("/home/u", ".doit", "trust", "acks");
    const exists = (p: string) => p === oldPath;
    expect(resolveDataDir(["trust", "acks"], { exists, homedir })).toBe(oldPath);
  });
});
