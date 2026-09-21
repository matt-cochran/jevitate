import { expect, test } from "vitest";
import type { Step, Recording } from "@jevitate/recording";
import { isWriteStep, postconditionOf, extractTail, healRecording, flattenRecording } from "./self-heal.js";

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

function baseRecording(): Recording {
  return {
    version: "1.0",
    site: "https://example.test",
    pages: [
      {
        url: "/a",
        steps: [
          { step: { kind: "navigate", url: "/a", expect: { kind: "visible", target: { testId: "loaded" } } } }, // 0
          { step: { kind: "click", target: { testId: "old-button" }, expect: { kind: "visible", target: { testId: "next" } } } }, // 1 (broken)
        ],
      },
      {
        url: "/b",
        steps: [
          { step: { kind: "assert", check: { kind: "urlIncludes", text: "/b" } } }, // 2
        ],
      },
    ],
  };
}

test("flattenRecording preserves page-then-step order", () => {
  expect(flattenRecording(baseRecording()).map((e) => e.step.kind)).toEqual(["navigate", "click", "assert"]);
});

test("extractTail returns every step from the given flat index onward, re-flowed into pages", () => {
  const tail = extractTail(baseRecording(), 2);
  expect(tail).toEqual([{ url: "/b", steps: [{ step: { kind: "assert", check: { kind: "urlIncludes", text: "/b" } } }] }]);
});

test("healRecording replaces exactly the broken step and preserves the tail unchanged", () => {
  const base = baseRecording();
  const healedSegment: Recording = {
    version: "1.0",
    site: "https://example.test",
    pages: [{ url: "/a", steps: [{ step: { kind: "click", target: { testId: "new-button" }, expect: { kind: "visible", target: { testId: "next" } } } }] }],
  };
  const healed = healRecording(base, 1, healedSegment);
  const flat = flattenRecording(healed);
  expect(flat).toHaveLength(3);
  expect(flat[0].step.kind).toBe("navigate"); // unchanged before the break
  expect(flat[1].step).toEqual(healedSegment.pages[0].steps[0].step); // the re-learned replacement
  expect(flat[2].step.kind).toBe("assert"); // the original tail, preserved
});
