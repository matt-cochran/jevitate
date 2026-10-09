import { describe, expect, it } from "vitest";
import { GOAL_OUTCOMES, MISSION_EXIT_CODES, combineOutcomes, defectOutcomeOf, foldGoalOutcome, goalMissionOutcome, goalReasonOf, startedOutcome, worstOutcome, type MissionOutcome } from "./mission-outcome.js";
import { journeyExitCode } from "./journey-outcome.js";

describe("defectOutcomeOf (#421/#423)", () => {
  it("no defects: status none, empty byKind, no advisoryByKind", () => {
    expect(defectOutcomeOf([])).toEqual({ status: "none", byKind: {} });
  });

  it("counts gating defects per kind; advisory ones apart and never setting the status", () => {
    const out = defectOutcomeOf([
      { kind: "server-log" },
      { kind: "server-log" },
      { kind: "http-5xx" },
      { kind: "judgment-flagged-state", advisory: true },
    ]);
    expect(out).toEqual({ status: "defects", byKind: { "server-log": 2, "http-5xx": 1 }, advisoryByKind: { "judgment-flagged-state": 1 } });
    expect(defectOutcomeOf([{ kind: "server-log", advisory: true }])).toEqual({ status: "none", byKind: {}, advisoryByKind: { "server-log": 1 } });
  });
});

describe("goalMissionOutcome — THE goal × defect table (#423)", () => {
  // The 0.7.0 rule it replaces: a defect turned any goal ending but a broken run / hang into
  // `defects-found`, and the result folded that. The exit code must be the same for every combination.
  const BROKEN = new Set(["inconclusive", "crashed", "hang", "intermittent", "not-started"]);
  const legacy = (goal: (typeof GOAL_OUTCOMES)[number], defects: boolean): MissionOutcome =>
    foldGoalOutcome(defects && !BROKEN.has(goal) ? "defects-found" : goal);

  it("matches the documented table", () => {
    expect(goalMissionOutcome("succeeded", "none")).toBe("clean");
    expect(goalMissionOutcome("succeeded", "defects")).toBe("defects-found");
    for (const g of ["failed", "exhausted", "blocked", "defects-found"] as const) {
      expect(goalMissionOutcome(g, "none")).toBe("defects-found");
      expect(goalMissionOutcome(g, "defects")).toBe("defects-found");
    }
    for (const g of ["hang", "intermittent", "inconclusive", "crashed"] as const) {
      expect(goalMissionOutcome(g, "none")).toBe(g);
      expect(goalMissionOutcome(g, "defects")).toBe(g);
    }
  });

  it("keeps every exit code stable against the 0.7.0 rule", () => {
    for (const g of GOAL_OUTCOMES) {
      for (const d of [false, true]) {
        expect(MISSION_EXIT_CODES[goalMissionOutcome(g, d ? "defects" : "none")], `${g} defects=${d}`).toBe(MISSION_EXIT_CODES[legacy(g, d)]);
      }
    }
  });
});

describe("goalReasonOf (#423): decided from the run's state, never from reason text", () => {
  it("names why a goal was not achieved", () => {
    expect(goalReasonOf({ goalOutcome: "succeeded" })).toBeUndefined();
    expect(goalReasonOf({ goalOutcome: "failed", stop: "done" })).toBe("success-check-failed");
    expect(goalReasonOf({ goalOutcome: "exhausted", stop: "exhausted" })).toBe("budget");
    expect(goalReasonOf({ goalOutcome: "blocked", stop: "blocked", missCause: "not-found" })).toBe("not-found");
    expect(goalReasonOf({ goalOutcome: "blocked", stop: "blocked", missCause: "ungrounded" })).toBe("ungrounded");
    expect(goalReasonOf({ goalOutcome: "blocked", stop: "blocked", missCause: "blocked-by-policy" })).toBe("blocked-by-policy");
    expect(goalReasonOf({ goalOutcome: "blocked", stop: "blocked" })).toBe("gave-up");
    expect(goalReasonOf({ goalOutcome: "blocked", stop: "no-progress" })).toBe("no-progress");
    expect(goalReasonOf({ goalOutcome: "hang" })).toBe("hang");
    expect(goalReasonOf({ goalOutcome: "intermittent" })).toBe("hang");
    expect(goalReasonOf({ goalOutcome: "inconclusive", failureKind: "vacuous-check" })).toBe("vacuous-check");
    expect(goalReasonOf({ goalOutcome: "inconclusive", stop: "budget" })).toBe("budget");
    expect(goalReasonOf({ goalOutcome: "inconclusive", failureKind: "target-unresponsive" })).toBe("broken-run");
    expect(goalReasonOf({ goalOutcome: "crashed" })).toBe("broken-run");
    // An invariant overrode a budget stop: the overridden ending explains the goal.
    expect(goalReasonOf({ goalOutcome: "defects-found", overridden: "inconclusive", stop: "budget" })).toBe("budget");
    expect(goalReasonOf({ goalOutcome: "defects-found" })).toBe("defects");
  });
});

describe("not-started (#448): a run with zero executed actions was never exercised", () => {
  it("folds to inconclusive with exit code 2, never clean", () => {
    expect([foldGoalOutcome("not-started"), MISSION_EXIT_CODES[goalMissionOutcome("not-started", "none")]]).toEqual(["inconclusive", 2]);
  });

  it("stays inconclusive when defects were found passively", () => {
    expect(goalMissionOutcome("not-started", "defects")).toBe("inconclusive");
  });

  it("demotes a succeeded goal with zero executed actions", () => {
    expect(startedOutcome("succeeded", 0)).toBe("not-started");
  });

  it("keeps a succeeded goal that executed an action", () => {
    expect(startedOutcome("succeeded", 1)).toBe("succeeded");
  });

  it("keeps a zero-action hang as a hang", () => {
    expect(startedOutcome("hang", 0)).toBe("hang");
  });

  it("demotes a zero-action inconclusive only for an auth or configuration preflight failure", () => {
    expect([startedOutcome("inconclusive", 0, "auth-expired"), startedOutcome("inconclusive", 0, "target-unreachable")]).toEqual(["not-started", "inconclusive"]);
  });

  it("names no-controls as the reason when the page offered none", () => {
    expect(goalReasonOf({ goalOutcome: "not-started", missCause: "no-controls" })).toBe("no-controls");
  });

  it("names auth-failed as the reason for an expired session", () => {
    expect(goalReasonOf({ goalOutcome: "not-started", failureKind: "auth-expired" })).toBe("auth-failed");
  });

  it("names preflight-failed as the reason for a failed configuration", () => {
    expect(goalReasonOf({ goalOutcome: "not-started", failureKind: "configuration" })).toBe("preflight-failed");
  });

  it("falls back to no-actions when the cause is unknown", () => {
    expect(goalReasonOf({ goalOutcome: "not-started" })).toBe("no-actions");
  });
});

describe("pending-review (#453)", () => {
  it("exits 5", () => {
    expect(MISSION_EXIT_CODES["pending-review"]).toBe(5);
  });
  it("is worse than clean", () => {
    expect(worstOutcome("clean", "pending-review")).toBe("pending-review");
  });
  it("is milder than defects-found", () => {
    expect(combineOutcomes(["pending-review", "defects-found"])).toBe("defects-found");
  });
});

describe("journeyExitCode (#453)", () => {
  it("maps ok/healed-pending-review/heal-exhausted/quarantined to 0/5/1/1", () => {
    expect((["ok", "healed-pending-review", "heal-exhausted", "quarantined"] as const).map(journeyExitCode)).toEqual([0, 5, 1, 1]);
  });
});
