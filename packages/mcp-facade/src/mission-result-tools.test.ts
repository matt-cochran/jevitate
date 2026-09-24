import { describe, expect, it } from "vitest";
import { isMissionResultId, isQueuedMissionId, missionResultFileName, parseResultOutcome } from "./mission-result-tools.js";

const STAMP = "2026-09-24T15-24-50-561Z";

describe("mission result ids (#117)", () => {
  it("accepts every result stem the CLI writes", () => {
    for (const id of [
      `explore-${STAMP}`,
      `coverage-${STAMP}`,
      `adversarial-${STAMP}`,
      `feature-${STAMP}`,
      `usability-${STAMP}`,
      `usability-${STAMP}.recording`,
    ]) {
      expect(isMissionResultId(id), id).toBe(true);
    }
  });

  it("refuses anything else — no separator, no '..', no other suffix or prefix", () => {
    for (const id of [
      `../explore-${STAMP}`,
      `explore-${STAMP}/../../etc/passwd`,
      `explore-${STAMP}.recording`,
      `usability-${STAMP}.recording.result`,
      `usability-${STAMP}.transcript`,
      `explore-${STAMP}\n`,
      `exploratory-${STAMP}`,
      "explore-2026-09-24",
      "549db40a-cd30-4706-b7f5-01ddea8f6d1f",
      "",
      42,
      undefined,
    ]) {
      expect(isMissionResultId(id), String(id)).toBe(false);
    }
  });

  it("recognizes a queue_exploration missionId (a uuid) and nothing path-shaped", () => {
    expect(isQueuedMissionId("549db40a-cd30-4706-b7f5-01ddea8f6d1f")).toBe(true);
    for (const id of ["549db40a-cd30-4706-b7f5-01ddea8f6d1f/..", "../549db40a-cd30-4706-b7f5-01ddea8f6d1f", `explore-${STAMP}`, "m-1"]) {
      expect(isQueuedMissionId(id), id).toBe(false);
    }
  });

  it("maps an id to its result file; a usability report stem to its Recording's result", () => {
    expect(missionResultFileName(`explore-${STAMP}`)).toBe(`explore-${STAMP}.result.json`);
    expect(missionResultFileName(`usability-${STAMP}`)).toBe(`usability-${STAMP}.recording.result.json`);
    expect(missionResultFileName(`usability-${STAMP}.recording`)).toBe(`usability-${STAMP}.recording.result.json`);
    expect(() => missionResultFileName("../x")).toThrow();
  });

  it("folds a goal run's own outcome onto the canonical one, keeping the goal's word", () => {
    expect(parseResultOutcome("clean")).toEqual({ outcome: "clean" });
    expect(parseResultOutcome("succeeded")).toEqual({ outcome: "clean", goalOutcome: "succeeded" });
    expect(parseResultOutcome("exhausted")).toEqual({ outcome: "defects-found", goalOutcome: "exhausted" });
    expect(parseResultOutcome("blocked")).toEqual({ outcome: "defects-found", goalOutcome: "blocked" });
    expect(parseResultOutcome("toString")).toBeNull();
    expect(parseResultOutcome("bogus")).toBeNull();
  });
});
