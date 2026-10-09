import { expect, test } from "vitest";
import type { Step, Recording } from "@jevitate/recording";
import { isWriteStep, retargetRecording, flattenRecording } from "./self-heal.js";

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

test("retargetRecording replaces exactly the step at the index, keeping every other step and its recorded fields", () => {
  const base = baseRecording();
  const step: Step = { kind: "click", target: { testId: "new-button" }, expect: { kind: "visible", target: { testId: "next" } } };
  const out = retargetRecording(base, 1, step);
  expect(out).toEqual({ ...base, pages: [{ ...base.pages[0]!, steps: [base.pages[0]!.steps[0]!, { step }] }, base.pages[1]] });
});
