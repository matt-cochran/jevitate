import { expect, test } from "vitest";
import { ok, fail } from "./envelope.js";

test("ok envelope is versioned and successful", () => {
  expect(ok({ x: 1 })).toEqual({ v: 1, ok: true, data: { x: 1 } });
});

test("fail envelope carries a code and message", () => {
  expect(fail("E_BAD", "nope")).toEqual({ v: 1, ok: false, error: { code: "E_BAD", message: "nope" } });
});
