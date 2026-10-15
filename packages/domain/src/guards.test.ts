import { expect, test } from "vitest";
import { isNodeError, isPlainObject, isRecord } from "./guards.js";

test("isRecord accepts a non-null object", () => {
  expect(isRecord({ a: 1 })).toBe(true);
});

test("isRecord rejects null", () => {
  expect(isRecord(null)).toBe(false);
});

test("isRecord rejects an array", () => {
  expect(isRecord([])).toBe(false);
});

test("isPlainObject accepts a non-null object", () => {
  expect(isPlainObject({ a: 1 })).toBe(true);
});

test("isPlainObject rejects null", () => {
  expect(isPlainObject(null)).toBe(false);
});

test("isPlainObject rejects an array", () => {
  expect(isPlainObject([])).toBe(false);
});

test("isNodeError accepts an error carrying the requested code", () => {
  expect(isNodeError(Object.assign(new Error("missing"), { code: "ENOENT" }), "ENOENT")).toBe(true);
});

test("isNodeError rejects an error carrying a different code", () => {
  expect(isNodeError(Object.assign(new Error("exists"), { code: "EEXIST" }), "ENOENT")).toBe(false);
});

test("isNodeError rejects a non-error value", () => {
  expect(isNodeError("ENOENT", "ENOENT")).toBe(false);
});
