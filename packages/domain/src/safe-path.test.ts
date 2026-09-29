import { describe, expect, it } from "vitest";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { UnsafeNameError, assertInsideRoot, assertSafeName, safeChildPath } from "./safe-path.js";

const ROOT = join(tmpdir(), "jev-safe-path-root");

describe("#221: a user-supplied name is one safe path segment inside its root", () => {
  it.each(["../x", "a/../../x", "/etc/passwd", "..\\x", "..", ".", ".hidden", "a/b", "a\\b", "x\u0000y", "", "a..b", "a".repeat(129)])("refuses %j", (name) => {
    expect(() => assertSafeName(name, "profile name")).toThrow(UnsafeNameError);
    expect(() => safeChildPath(ROOT, name)).toThrow(UnsafeNameError);
  });

  it.each(["default", "work-2", "a.b_c", "A1", "a".repeat(128)])("accepts %j, resolved inside the root", (name) => {
    expect(safeChildPath(ROOT, name, { suffix: ".json" })).toBe(join(resolve(ROOT), `${name}.json`));
  });

  it("the refusal is a usage error code (E_INVALID_*)", () => {
    expect(() => assertSafeName("../x")).toThrow(expect.objectContaining({ code: "E_INVALID_NAME" }));
  });

  it("defence in depth: a path that resolves outside (or to) the root is refused whatever the name rule says", () => {
    expect(() => assertInsideRoot(ROOT, "../x")).toThrow(UnsafeNameError);
    expect(() => assertInsideRoot(ROOT, "a/../../x")).toThrow(UnsafeNameError);
    expect(() => assertInsideRoot(ROOT, "/etc/passwd")).toThrow(UnsafeNameError);
    expect(() => assertInsideRoot(ROOT, ".")).toThrow(UnsafeNameError);
    expect(assertInsideRoot(ROOT, "a/b")).toBe(join(resolve(ROOT), "a", "b"));
  });
});
