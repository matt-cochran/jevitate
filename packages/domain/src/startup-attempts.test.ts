import { describe, expect, it } from "vitest";
import { StartupAttemptSchema, startupAttemptsOf } from "./mission-outcome.js";
import { MissionResultSchema } from "./mission-result.js";

/** A minimal valid coverage result; `extra` adds the strategy-specific fields under test. */
function coverageResult(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    strategy: "coverage",
    missionOutcome: "inconclusive",
    exitCode: 2,
    defects: [],
    hangs: [],
    recordingPaths: [],
    transcriptPath: "run.transcript.json",
    resultPath: "run.result.json",
    target: { seedUrl: "http://127.0.0.1:5173/", allowlist: [] },
    engine: { version: "0.0.0", commit: "0".repeat(40), builtAt: "2026-01-01T00:00:00.000Z" },
    ...extra,
  };
}

describe("startup attempts (#742)", () => {
  it("round-trips a recorded failed startup attempt", () => {
    const attempt = {
      index: 0,
      errorClass: "navigation-timeout",
      message: "timed out before any response",
      startedAt: 1_700_000_000_000,
      endedAt: 1_700_000_030_000,
    };
    expect(StartupAttemptSchema.parse(JSON.parse(JSON.stringify(attempt)))).toEqual(attempt);
  });

  it("accepts a final successful attempt with no error class", () => {
    const attempt = { index: 1, errorClass: null, message: "", startedAt: 1_700_000_030_000, endedAt: 1_700_000_030_100 };
    expect(StartupAttemptSchema.safeParse(attempt).success).toBe(true);
  });

  it("refuses a startup attempt whose error class is not documented", () => {
    const attempt = { index: 0, errorClass: "made-up", message: "x", startedAt: 0, endedAt: 1 };
    expect(StartupAttemptSchema.safeParse(attempt).success).toBe(false);
  });

  it("reads the typed startup attempts a run result records", () => {
    const attempt = { index: 0, errorClass: "dns", message: "host not found", startedAt: 1, endedAt: 2 };
    expect(startupAttemptsOf({ strategy: "coverage", attempts: [attempt] })).toEqual([attempt]);
  });

  it("reads no startup attempts from a result written before the field existed", () => {
    expect(startupAttemptsOf({ strategy: "coverage", missionOutcome: "inconclusive" })).toEqual([]);
  });

  it("serializes a run result's startup attempts through the result schema", () => {
    const attempt = { index: 0, errorClass: "connectivity", message: "connection refused", startedAt: 1, endedAt: 2 };
    const json = JSON.parse(JSON.stringify(coverageResult({ attempts: [attempt] })));
    expect(startupAttemptsOf(MissionResultSchema.parse(json))).toEqual([attempt]);
  });

  it("parses a run result written before attempts existed", () => {
    expect(MissionResultSchema.safeParse(coverageResult()).success).toBe(true);
  });
});
