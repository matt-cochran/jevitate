// Live quality regression (opt-in: RUN_UX_QUALITY=1 + TYPESAFE_API_KEY + OPENROUTER_API_KEY).
// Replays the committed cross-app corpus through the full pipeline (Jev judgment → specifics →
// code adjudication → dedupe → independent grader) and FAILS if, on any app, the grader's
// actionable+relevant share or the run-to-run consistency of shown findings drops below the
// baseline recorded for the shipped prompt version minus its tolerance.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { UX_PROMPTS, UxAnalyzer, a11yChecks, buildReport, loadV1Rubric } from "@jevitate/ux";

const RUN = process.env.RUN_UX_QUALITY === "1";
const dir = new URL("../scripts/ux-quality/", import.meta.url);
const baseline = JSON.parse(readFileSync(new URL("baseline.json", dir), "utf8"));

describe.skipIf(!RUN)("UX quality regression (live, opt-in)", () => {
  it(
    "holds the baseline act+rel share and consistency per app",
    async () => {
      const { liveGateways } = await import(new URL("gateways.mjs", dir).href);
      const stats = await import(new URL("stats.mjs", dir).href);
      const corpus = JSON.parse(readFileSync(new URL(baseline.corpus, dir), "utf8"));
      const { judge, gen } = await liveGateways();
      expect(baseline.promptsVersion).toBe(UX_PROMPTS.version);
      for (const [app, want] of Object.entries<{ goodShare: number; jaccard: number }>(baseline.apps)) {
        const screens = corpus.screens.filter((s: { app: string }) => s.app === app);
        const runs = [];
        for (let r = 0; r < baseline.runs; r++) {
          const outcome = await new UxAnalyzer({ judge, gen, a11yChecker: a11yChecks }).analyze({
            screens: screens.map((s: Record<string, unknown> & { app: string; id: string; controls: unknown[] }) => ({
              screenId: `${s.app}/${s.id}`, url: s.url, controls: s.controls, visibleText: s.visibleText,
              appContext: { appClass: s.appClass, job: s.job }, job: s.job, history: [],
              behavior: { noProgress: false, backtracks: 0, formReentry: 0, dwellMs: 0, errors: 0 }, a11yFacts: { controls: [] },
            })),
            rubric: loadV1Rubric(),
            appContext: { appClass: screens[0].appClass, job: screens[0].job },
            judgmentBudget: 1000,
          });
          if (outcome.kind === "failed") throw new Error(outcome.reason);
          runs.push(buildReport(outcome, { minConfidence: 0, quality: { show: ["actionable", "relevant-minor", "generic", "wrong"] } }).findings.filter((f) => f.tier === "semantic"));
        }
        const all = runs.flat();
        const good = all.filter((f) => f.quality && stats.SHOWN.has(f.quality.label)).length / Math.max(1, all.length);
        const c = stats.consistency(runs, (f: { quality?: { label: string } }) => !!f.quality && stats.SHOWN.has(f.quality.label), stats.routeKey);
        expect.soft(good, `${app} act+rel share`).toBeGreaterThanOrEqual(want.goodShare - baseline.tolerance.goodShare);
        expect.soft(c.meanJaccard, `${app} Jaccard`).toBeGreaterThanOrEqual(want.jaccard - baseline.tolerance.jaccard);
      }
    },
    60 * 60 * 1000,
  );
});
