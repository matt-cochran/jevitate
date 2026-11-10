import { describe, expect, it } from "vitest";
import { goalMissionOutcome, goalReasonOf, MISSION_EXIT_CODES } from "@jevitate/domain";
import { goalJobDecision, goalJobFold, type GoalJobInput } from "./explore-job-done-check.js";
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

describe("rc-030: the final fresh reading of a run the loop did not decide", () => {
  const ended = (over: Partial<GoalJobInput>): GoalJobInput => pass({ completed: false, goalOutcome: "blocked", foldedOutcome: "blocked", hasReader: true, ...over });

  it("false is not-achieved, true is achieved (false before, true after)", () => {
    expect(goalJobDecision(ended({ lastReading: false })).job).toEqual({ attainment: "not-achieved", basis: "done-check" });
    expect(goalJobDecision(ended({ lastReading: true })).job).toEqual({ attainment: "achieved", basis: "done-check" });
  });

  it("an unreadable one stays reading-unknown, with its reason, and never becomes true or false", () => {
    expect(goalJobDecision(ended({ lastReading: null, unknownReason: "page-replaced" })).job).toEqual({ attainment: "unverified", basis: "reading-unknown", reason: "page-replaced" });
    expect(goalJobDecision(ended({ lastReading: null })).job).toEqual({ attainment: "unverified", basis: "reading-unknown" });
  });
});

describe("decision 2: a pass whose done check reads false exits 1 (goalJobFold)", () => {
  it("a grounded-answer pass whose final reading is false is defects-found, done-check-failed, exit 1", () => {
    const d = goalJobDecision(pass({ completed: true, verifiedBy: "grounded-answer", hasReader: true, lastReading: false }));
    expect(d.job).toEqual({ attainment: "not-achieved", basis: "done-check" });
    const f = goalJobFold({ foldedOutcome: "clean", ...d });
    expect(f.missionOutcome).toBe("defects-found");
    expect(f.failure?.kind).toBe("done-check-failed");
    expect(MISSION_EXIT_CODES[f.missionOutcome]).toBe(1);
  });

  it("the find-out exemption covers only unverified, never not-achieved; advisory does not soften it", () => {
    for (const verifiedBy of ["grounded-answer", "success-condition", "grounded-judgment"] as const) {
      for (const policy of ["require", "advisory"] as const) {
        const d = goalJobDecision(pass({ verifiedBy, policy, hasReader: true, lastReading: false }));
        expect(goalJobFold({ foldedOutcome: "clean", ...d }).missionOutcome).toBe("defects-found");
      }
    }
    // A pending review is a pass too: not-achieved outranks it, as journeyMissionOutcome does.
    const d = goalJobDecision(pass({ hasReader: true, lastReading: false }));
    expect(goalJobFold({ foldedOutcome: "pending-review", ...d }).missionOutcome).toBe("defects-found");
  });

  it("a run already failing keeps its own ending; achieved and unverified folds are unchanged", () => {
    const failed = goalJobDecision(pass({ completed: false, goalOutcome: "blocked", foldedOutcome: "defects-found", hasReader: true, lastReading: false }));
    expect(goalJobFold({ foldedOutcome: "inconclusive", ...failed })).toEqual({ missionOutcome: "inconclusive" });
    const achieved = goalJobDecision(pass({ hasReader: true, lastReading: true }));
    expect(goalJobFold({ foldedOutcome: "clean", ...achieved })).toEqual({ missionOutcome: "clean" });
    const unverified = goalJobDecision(pass({ verifiedBy: "grounded-judgment" }));
    expect(goalJobFold({ foldedOutcome: "clean", ...unverified })).toEqual({ missionOutcome: "inconclusive" });
    const harness = goalJobDecision(pass({ hasReader: true, lastReading: false, trust: "harness" }));
    expect(goalJobFold({ foldedOutcome: "clean", ...harness })).toEqual({ missionOutcome: "clean" });
  });
});

describe("rc-030b: the goal's own fields agree with the job fold", () => {
  it("job-http looks-done-wrong-page r8: a pass whose done check read false is goalOutcome failed, goalReason done-check-failed, exit 1", () => {
    const d = goalJobDecision(pass({ verifiedBy: "grounded-judgment", hasReader: true, lastReading: false }));
    const f = goalJobFold({ foldedOutcome: "clean", ...d, goalOutcome: "succeeded", defects: "none", runFailed: false });
    expect(f).toMatchObject({ missionOutcome: "defects-found", goalOutcome: "failed", failure: { kind: "done-check-failed" } });
    expect(goalReasonOf({ goalOutcome: f.goalOutcome!, stop: "done", failureKind: f.failure!.kind })).toBe("done-check-failed");
    // The table agrees: the goal's own ending folds to the same mission outcome and exit code.
    expect(goalMissionOutcome(f.goalOutcome!, "none")).toBe(f.missionOutcome);
    expect(MISSION_EXIT_CODES[f.missionOutcome]).toBe(1);
  });

  it("job-page looks-done-wrong-page r7 (job gates, proof advisory): achieved over the model's blocked is succeeded, clean, exit 0", () => {
    const d = goalJobDecision(pass({ completed: false, goalOutcome: "blocked", foldedOutcome: "defects-found", hasReader: true, lastReading: true }));
    expect(d.job).toEqual({ attainment: "achieved", basis: "done-check" });
    for (const goalOutcome of ["blocked", "exhausted"]) {
      const f = goalJobFold({ foldedOutcome: "defects-found", ...d, goalOutcome, defects: "none", runFailed: false });
      expect(f).toMatchObject({ missionOutcome: "clean", goalOutcome: "succeeded" });
      expect(f.note).toMatch(/the job decides/);
      expect(MISSION_EXIT_CODES[f.missionOutcome]).toBe(0);
    }
  });

  it("achieved never overrides a defect, a run failure, an independent check that did not hold, or a boundary/hang/crash", () => {
    const d = goalJobDecision(pass({ completed: false, goalOutcome: "blocked", foldedOutcome: "defects-found", hasReader: true, lastReading: true }));
    expect(goalJobFold({ foldedOutcome: "defects-found", ...d, goalOutcome: "blocked", defects: "defects", runFailed: false })).toEqual({ missionOutcome: "defects-found" });
    expect(goalJobFold({ foldedOutcome: "defects-found", ...d, goalOutcome: "blocked", defects: "none", runFailed: true })).toEqual({ missionOutcome: "defects-found" });
    for (const [goalOutcome, folded] of [["failed", "defects-found"], ["boundary", "inconclusive"], ["hang", "hang"], ["crashed", "crashed"], ["inconclusive", "inconclusive"]] as const) {
      expect(goalJobFold({ foldedOutcome: folded, ...d, goalOutcome, defects: "none", runFailed: false })).toEqual({ missionOutcome: folded });
    }
    // An achieved job read already-true, or on a harness, decides nothing.
    for (const job of [{ attainment: "unverified", basis: "already-true" }, { attainment: "unverified", basis: "harness" }] as const) {
      expect(goalJobFold({ foldedOutcome: "defects-found", job, unverifiedPass: false, goalOutcome: "blocked", defects: "none", runFailed: false })).toEqual({ missionOutcome: "defects-found" });
    }
  });
});
