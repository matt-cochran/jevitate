import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { resolveDataDir } from "./data-dir.js";

const homedir = () => "/home/u";

describe("resolveDataDir (~/.jevitate, greenfield — no ~/.doit)", () => {
  it("resolves a single segment under ~/.jevitate", () => {
    expect(resolveDataDir(["db.sqlite"], { homedir })).toBe(join("/home/u", ".jevitate", "db.sqlite"));
  });

  it("joins nested segments (e.g. trust/acks)", () => {
    expect(resolveDataDir(["trust", "acks"], { homedir })).toBe(join("/home/u", ".jevitate", "trust", "acks"));
  });
});
