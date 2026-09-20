import { expect, test } from "vitest";
import type { Step } from "@jevitate/recording";
import { isWriteStep, postconditionOf } from "./self-heal.js";

const visible: Step["kind"] extends never ? never : { kind: "visible"; target: { testId: string } } = { kind: "visible", target: { testId: "ok" } };

test("navigate/waitFor/extract/assert are read-only", () => {
  expect(isWriteStep({ kind: "navigate", url: "/x", expect: visible })).toBe(false);
  expect(isWriteStep({ kind: "waitFor", target: { testId: "x" }, state: "visible" })).toBe(false);
  expect(isWriteStep({ kind: "extract", target: { testId: "x" }, as: "v", expect: visible })).toBe(false);
  expect(isWriteStep({ kind: "assert", check: visible })).toBe(false);
});

test("click/fill/select/press/forEach/handback are writes", () => {
  expect(isWriteStep({ kind: "click", target: { testId: "x" }, expect: visible })).toBe(true);
  expect(isWriteStep({ kind: "fill", target: { testId: "x" }, value: { redacted: true, length: 1 }, expect: visible })).toBe(true);
  expect(isWriteStep({ kind: "select", target: { testId: "x" }, value: { redacted: true, length: 1 }, expect: visible })).toBe(true);
  expect(isWriteStep({ kind: "press", key: "Enter", expect: visible })).toBe(true);
  expect(isWriteStep({ kind: "forEach", items: { testId: "x" }, as: "row", steps: [] })).toBe(true);
  expect(isWriteStep({ kind: "handback", prompt: "p", resume: visible })).toBe(true);
});

test("postconditionOf returns the step's own Assertion for navigate/click/fill/select/press/extract/assert", () => {
  expect(postconditionOf({ kind: "navigate", url: "/x", expect: visible })).toBe(visible);
  expect(postconditionOf({ kind: "click", target: { testId: "x" }, expect: visible })).toBe(visible);
  expect(postconditionOf({ kind: "assert", check: visible })).toBe(visible);
});

test("postconditionOf returns undefined for waitFor/forEach (no Assertion to reach)", () => {
  expect(postconditionOf({ kind: "waitFor", target: { testId: "x" }, state: "visible" })).toBeUndefined();
  expect(postconditionOf({ kind: "forEach", items: { testId: "x" }, as: "row", steps: [] })).toBeUndefined();
});
