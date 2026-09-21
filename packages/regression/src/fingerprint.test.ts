import { expect, test } from "vitest";
import type { Recording } from "@jevitate/recording";
import { fingerprintFailure, matchesFingerprint, flattenWithUrls } from "./fingerprint.js";

function rec(): Recording {
  return {
    version: "1.0",
    site: "https://example.test",
    pages: [
      {
        url: "/inbox",
        steps: [
          { step: { kind: "navigate", url: "/inbox", expect: { kind: "visible", target: { testId: "loaded" } } } },
          { step: { kind: "click", target: { role: "button", name: "Compose" }, expect: { kind: "visible", target: { testId: "editor" } } } },
        ],
      },
    ],
  };
}

test("fingerprintFailure captures the strict signature of the step at the given flat index", () => {
  const fp = fingerprintFailure(rec(), 1);
  expect(fp.stepSignature).toContain("click");
  expect(fp.stepSignature).toContain("Compose");
});

test("matchesFingerprint is true for the same structural step, false for a different one", () => {
  const fp = fingerprintFailure(rec(), 1);
  expect(matchesFingerprint(rec(), 1, fp)).toBe(true);
  expect(matchesFingerprint(rec(), 0, fp)).toBe(false);
});

test("fingerprintFailure throws for an out-of-range index", () => {
  expect(() => fingerprintFailure(rec(), 5)).toThrow(/out of range/);
});

test("flattenWithUrls preserves page-then-step order with each step's page url", () => {
  const flat = flattenWithUrls(rec());
  expect(flat).toHaveLength(2);
  expect(flat[0].pageUrl).toBe("/inbox");
  expect(flat[1].step.step.kind).toBe("click");
});
