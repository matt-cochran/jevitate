import { describe, expect, it } from "vitest";
import type { JourneyPrefix } from "../journey-prefix.js";
import { resolveScopeRegions } from "./scope-region.js";

/** #519: the run's scope region — the anchor's or `--scope-region`'s, never both, only for region strategies. */

const prefixWithRegion = {
  branch: { journeyId: "wiz", step: 2, anchor: "wizard" },
  region: { spec: "testId=import-view", descriptor: { testId: "import-view" } },
} as unknown as JourneyPrefix;

describe("resolveScopeRegions (#519)", () => {
  it("parses repeatable --scope-region", () => {
    expect(resolveScopeRegions({ scopeRegion: ["testId=a", "role=region;name=Import"], strategy: "adversarial" })).toEqual({
      descriptors: [{ testId: "a" }, { role: "region", name: "Import" }],
      spec: "testId=a | role=region;name=Import",
    });
  });

  it("uses the anchor's region by default", () => {
    expect(resolveScopeRegions({ scopeRegion: [], strategy: "coverage" }, prefixWithRegion)?.spec).toBe("testId=import-view");
  });

  it("refuses --scope-region when the anchor declares one, naming the anchor and its region", () => {
    expect(() => resolveScopeRegions({ scopeRegion: ["testId=x"], strategy: "adversarial" }, prefixWithRegion)).toThrow(/anchor wizard declares the scope region testId=import-view/);
  });

  it("points the refused operator at journey anchor add --region", () => {
    expect(() => resolveScopeRegions({ scopeRegion: ["testId=x"], strategy: "adversarial" }, prefixWithRegion)).toThrow(/journey anchor add --region/);
  });

  it("refuses --scope-region for a goal run", () => {
    expect(() => resolveScopeRegions({ scopeRegion: ["testId=x"], strategy: "goal", goal: "g" })).toThrow(/--scope-region applies to --strategy adversarial, coverage or exploratory/);
  });

  it("refuses --scope-region for a feature run", () => {
    expect(() => resolveScopeRegions({ scopeRegion: ["testId=x"], strategy: "goal", feature: "f" })).toThrow(/--scope-region applies to/);
  });

  it("refuses --scope-region for usability", () => {
    expect(() => resolveScopeRegions({ scopeRegion: ["testId=x"], strategy: "usability" })).toThrow(/--scope-region applies to/);
  });

  it("refuses an unparsable descriptor", () => {
    expect(() => resolveScopeRegions({ scopeRegion: ["Import Wizard"], strategy: "adversarial" })).toThrow(/has no usable selector/);
  });

  it("is undefined with neither", () => {
    expect(resolveScopeRegions({ scopeRegion: [], strategy: "adversarial" })).toBeUndefined();
  });

  it("ignores an anchor's region for a strategy with no coverage gate", () => {
    expect(resolveScopeRegions({ scopeRegion: [], strategy: "goal", goal: "g" }, prefixWithRegion)).toBeUndefined();
  });
});
