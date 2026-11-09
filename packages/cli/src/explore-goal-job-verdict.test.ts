import { describe, expect, it } from "vitest";
import { goalJobDecision, type GoalJobInput } from "./explore-job-done-check.js";
import { EXIT_CODES, exitCodeForError } from "./exit-codes.js";

/**
 * 0.30.0 wave E: the goal run's job verdict and its decision-3 fold (`explore --goal`, `mission run`):
 *  - #802 / exit-codes.md "Harness": a pass on a trust `harness` target reads unverified/harness and keeps exit 0,
 *    as `journey run` does (doneCheckExitInput, be83d00);
 *  - decision 3, 2026-11-09 clarification: a find-out run's grounded answer keeps exit 0 (no end state claimed);
 *  - an unknown `--job` id is a usage error (64), as the other unknown-id refusals.
 */

const pass = (over: Partial<GoalJobInput> = {}): GoalJobInput => ({
  completed: true,
  goalOutcome: "succeeded",
  foldedOutcome: "clean",
  hasReader: false,
  policy: "require",
  ...over,
});

describe("goalJobDecision", () => {
  it("a done check that read true is achieved on a test target, and the pass stays clean", () => {
    const d = goalJobDecision(pass({ hasReader: true, loopJob: { attainment: "achieved", basis: "done-check" }, trust: "test" }));
    expect(d).toEqual({ job: { attainment: "achieved", basis: "done-check" }, unverifiedPass: false });
  });

  it("#802: on a harness target the same pass reads unverified/harness and is not folded to inconclusive (exit 0)", () => {
    const d = goalJobDecision(pass({ hasReader: true, loopJob: { attainment: "achieved", basis: "done-check" }, trust: "harness" }));
    expect(d).toEqual({ job: { attainment: "unverified", basis: "harness" }, unverifiedPass: false });
  });

  it("#802: on a harness target a false reading is unverified/harness too, as the journey hook decides", () => {
    const d = goalJobDecision(pass({ completed: false, goalOutcome: "failed", foldedOutcome: "defects-found", hasReader: true, lastReading: false, trust: "harness" }));
    expect(d.job).toEqual({ attainment: "unverified", basis: "harness" });
  });

  it("#802: on a harness target a check already true before the run is unverified/harness too (exit 0)", () => {
    expect(goalJobDecision(pass({ basis: "already-true", trust: "harness" }))).toEqual({ job: { attainment: "unverified", basis: "harness" }, unverifiedPass: false });
  });

  it("#802: a harness target with no done check is no-check, under the policy (as a Journey with no check)", () => {
    expect(goalJobDecision(pass({ trust: "harness" }))).toEqual({ job: { attainment: "unverified", basis: "no-check" }, unverifiedPass: true });
  });

  it("decision 3: a judgment-only pass with no done check is unverified and exits 2 under require", () => {
    const d = goalJobDecision(pass({ verifiedBy: "grounded-judgment" }));
    expect(d).toEqual({ job: { attainment: "unverified", basis: "no-check" }, unverifiedPass: true });
  });

  it("decision 3 (2026-11-09): a find-out run's grounded answer keeps exit 0", () => {
    const d = goalJobDecision(pass({ verifiedBy: "grounded-answer" }));
    expect(d.job).toEqual({ attainment: "unverified", basis: "no-check" });
    expect(d.unverifiedPass).toBe(false);
  });

  it("an independent --success check stands, unless --require-done-check", () => {
    expect(goalJobDecision(pass({ verifiedBy: "success-condition" })).unverifiedPass).toBe(false);
    expect(goalJobDecision(pass({ verifiedBy: "success-condition", requireDoneCheck: true })).unverifiedPass).toBe(true);
    expect(goalJobDecision(pass({ verifiedBy: "grounded-answer", requireDoneCheck: true })).unverifiedPass).toBe(true);
  });

  it("advisory keeps exit 0; no policy given folds nothing", () => {
    expect(goalJobDecision(pass({ policy: "advisory" })).unverifiedPass).toBe(false);
    const { policy: _p, ...noPolicy } = pass();
    expect(goalJobDecision(noPolicy).unverifiedPass).toBe(false);
  });
});

describe("E_EXPLORE_JOB", () => {
  it("an unknown --job id (or an unreadable catalog) is a usage error: exit 64", () => {
    expect(exitCodeForError("E_EXPLORE_JOB")).toBe(EXIT_CODES.usage);
  });
});
