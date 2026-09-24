// Pins the shipped UX prompt assets to their MEASURED quality baseline. Any edit to
// packages/ux/src/assets/ux-prompts.json changes its hash and fails here until the change is
// re-measured with packages/cli/scripts/ux-quality (holdout apps included) and baseline.json is
// updated — a prompt change cannot ship unmeasured. The recorded per-app numbers must also clear
// the quality + consistency floors. The live re-measurement is ux-quality.integration.test.ts.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { UX_PROMPTS } from "@jevitate/ux";

const baseline = JSON.parse(readFileSync(new URL("../scripts/ux-quality/baseline.json", import.meta.url), "utf8"));
const asset = readFileSync(new URL("../../ux/src/assets/ux-prompts.json", import.meta.url));

describe("UX prompt quality baseline", () => {
  it("the shipped prompt asset is exactly the measured one", () => {
    expect(UX_PROMPTS.version).toBe(baseline.promptsVersion);
    expect(createHash("sha256").update(asset).digest("hex"), "prompts changed: re-measure (scripts/ux-quality) and update baseline.json").toBe(baseline.promptsSha256);
  });

  it("every app — tuning AND holdout — clears the act+rel share and consistency floors", () => {
    const apps = Object.entries<{ split: string; goodShare: number; jaccard: number }>(baseline.apps);
    expect(apps.filter(([, a]) => a.split === "holdout").length).toBeGreaterThanOrEqual(2);
    for (const [app, a] of apps) {
      expect(a.goodShare, `${app} act+rel share`).toBeGreaterThanOrEqual(baseline.floors.goodShare);
      expect(a.jaccard, `${app} run-to-run Jaccard`).toBeGreaterThanOrEqual(baseline.floors.jaccard);
    }
  });

  it("the grader was validated against human labels at or above its stated target", () => {
    expect(baseline.grader.handLabels.showHideKappa).toBeGreaterThanOrEqual(baseline.grader.targetShowHideKappa);
  });
});
