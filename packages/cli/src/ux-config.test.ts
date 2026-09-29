import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadUxMaxFindingsPerPage, loadUxMinConfidence, loadUxMinConfidenceByAppClass, loadUxShow, UxConfigError } from "./ux-config.js";

function withConfig(contents: unknown, fn: (path: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "jev-ux-config-"));
  const path = join(dir, "config.json");
  if (contents !== undefined) writeFileSync(path, typeof contents === "string" ? contents : JSON.stringify(contents));
  try {
    fn(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("loadUxMinConfidence", () => {
  it("a missing file is 'not configured'", () => {
    withConfig(undefined, (path) => expect(loadUxMinConfidence(path)).toBeUndefined());
  });

  it("reads ux.minConfidence when present", () => {
    withConfig({ ux: { minConfidence: 0.42 } }, (path) => expect(loadUxMinConfidence(path)).toBe(0.42));
  });

  it("an out-of-range value fails closed (throws), never silently replaced by the default", () => {
    withConfig({ ux: { minConfidence: 1.5 } }, (path) => expect(() => loadUxMinConfidence(path)).toThrow(UxConfigError));
  });

  it("malformed JSON throws", () => {
    withConfig("{not json", (path) => expect(() => loadUxMinConfidence(path)).toThrow(UxConfigError));
  });
});

describe("loadUxShow", () => {
  it("reads ux.show as a string array", () => {
    withConfig({ ux: { show: ["actionable", "wrong"] } }, (path) => expect(loadUxShow(path)).toEqual(["actionable", "wrong"]));
  });
});

describe("loadUxMaxFindingsPerPage (issue #198 interim per-page cap)", () => {
  it("a missing file/key is 'not configured'", () => {
    withConfig(undefined, (path) => expect(loadUxMaxFindingsPerPage(path)).toBeUndefined());
  });

  it("reads ux.maxFindingsPerPage when present", () => {
    withConfig({ ux: { maxFindingsPerPage: 3 } }, (path) => expect(loadUxMaxFindingsPerPage(path)).toBe(3));
  });

  it("a non-positive-integer value fails closed (throws), never silently replaced by the default", () => {
    withConfig({ ux: { maxFindingsPerPage: 0 } }, (path) => expect(() => loadUxMaxFindingsPerPage(path)).toThrow(UxConfigError));
    withConfig({ ux: { maxFindingsPerPage: 2.5 } }, (path) => expect(() => loadUxMaxFindingsPerPage(path)).toThrow(UxConfigError));
    withConfig({ ux: { maxFindingsPerPage: "5" } }, (path) => expect(() => loadUxMaxFindingsPerPage(path)).toThrow(UxConfigError));
  });
});

describe("loadUxMinConfidenceByAppClass (issue #97: per-`--app-class` threshold defaults)", () => {
  it("no appClass given => undefined, even with config present", () => {
    withConfig({ ux: { minConfidenceByAppClass: { consumer: 0.3 } } }, (path) => expect(loadUxMinConfidenceByAppClass(path, undefined)).toBeUndefined());
  });

  it("no config key present => undefined ('today's default where no data exists')", () => {
    withConfig({ ux: { minConfidence: 0.5 } }, (path) => expect(loadUxMinConfidenceByAppClass(path, "consumer")).toBeUndefined());
  });

  it("returns the value for a matching app class, case-insensitively", () => {
    withConfig({ ux: { minConfidenceByAppClass: { Consumer: 0.35 } } }, (path) => {
      expect(loadUxMinConfidenceByAppClass(path, "consumer")).toBe(0.35);
      expect(loadUxMinConfidenceByAppClass(path, "CONSUMER")).toBe(0.35);
      expect(loadUxMinConfidenceByAppClass(path, "  consumer  ")).toBe(0.35);
    });
  });

  it("an app class with no entry is undefined, distinct app classes don't leak into each other", () => {
    withConfig({ ux: { minConfidenceByAppClass: { consumer: 0.3, admin: 0.6 } } }, (path) => {
      expect(loadUxMinConfidenceByAppClass(path, "admin")).toBe(0.6);
      expect(loadUxMinConfidenceByAppClass(path, "developer-tool")).toBeUndefined();
    });
  });

  it("an out-of-range per-class value fails closed", () => {
    withConfig({ ux: { minConfidenceByAppClass: { consumer: -0.1 } } }, (path) => expect(() => loadUxMinConfidenceByAppClass(path, "consumer")).toThrow(UxConfigError));
  });

  it("a non-object minConfidenceByAppClass fails closed", () => {
    withConfig({ ux: { minConfidenceByAppClass: "nope" } }, (path) => expect(() => loadUxMinConfidenceByAppClass(path, "consumer")).toThrow(UxConfigError));
  });
});
