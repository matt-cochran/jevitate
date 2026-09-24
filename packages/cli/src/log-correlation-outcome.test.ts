import { describe, it, expect } from "vitest";
import { applyServerLogOutcome, type ServerLogRuntimeResult } from "./log-correlation.js";

/**
 * #142 exit-code follow-up: `applyServerLogOutcome` is the ONE shared rule the coverage, adversarial
 * and feature builders fold a server-log correlation into their own `MissionOutcome` with (the goal
 * mission has its own analogous, separately-tested `applyServerLogGoalOutcome` for its distinct
 * `GoalBasedOutcome` enum — see `server-log-e2e.test.ts`).
 */

function run(opts: { defects?: number; oracleOk: boolean }): ServerLogRuntimeResult {
  return {
    transcript: [],
    summary: {
      sources: [],
      byLevel: {},
      topMessages: [],
      attachedLines: 0,
      unattributedLines: 0,
      oracleOk: opts.oracleOk,
    },
    defects: Array.from({ length: opts.defects ?? 0 }, (_, i) => ({
      fingerprint: `${i}`.padStart(16, "0"),
      related: [],
      kind: "server-log" as const,
      title: "t",
      route: "/x",
      level: "error" as const,
      message: "m",
      occurrences: 1,
      repro: { recordingStepIndex: 0 },
      serverLog: { sources: [], matcher: "error", normalizedMessage: "m", drainMs: 0 },
    })),
  };
}

describe("applyServerLogOutcome (#142 exit-code follow-up)", () => {
  it("undefined (no --log-source) is a complete no-op", () => {
    expect(applyServerLogOutcome("clean", undefined)).toBe("clean");
    expect(applyServerLogOutcome("hang", undefined)).toBe("hang");
  });

  it("a found server-log defect makes a clean run defects-found", () => {
    expect(applyServerLogOutcome("clean", run({ defects: 1, oracleOk: true }))).toBe("defects-found");
  });

  it("a found server-log defect never DOWNGRADES a worse outcome (hang/crashed/inconclusive)", () => {
    expect(applyServerLogOutcome("hang", run({ defects: 1, oracleOk: true }))).toBe("hang");
    expect(applyServerLogOutcome("crashed", run({ defects: 1, oracleOk: true }))).toBe("crashed");
    expect(applyServerLogOutcome("inconclusive", run({ defects: 1, oracleOk: true }))).toBe("inconclusive");
  });

  it("a found server-log defect UPGRADES a lesser 'defects-found'-worthy outcome (worstOutcome semantics)", () => {
    // defects-found (severity 2) vs intermittent (severity 1): defects-found wins.
    expect(applyServerLogOutcome("intermittent", run({ defects: 1, oracleOk: true }))).toBe("defects-found");
  });

  it("an unreadable --log-defect oracle turns an otherwise-clean run inconclusive", () => {
    expect(applyServerLogOutcome("clean", run({ defects: 0, oracleOk: false }))).toBe("inconclusive");
  });

  it("an unreadable oracle does NOT touch an outcome that was not clean to begin with", () => {
    expect(applyServerLogOutcome("defects-found", run({ defects: 0, oracleOk: false }))).toBe("defects-found");
    expect(applyServerLogOutcome("hang", run({ defects: 0, oracleOk: false }))).toBe("hang");
  });

  it("a readable oracle that legitimately found nothing leaves the outcome untouched", () => {
    expect(applyServerLogOutcome("clean", run({ defects: 0, oracleOk: true }))).toBe("clean");
  });
});
