import { describe, expect, it } from "vitest";
import { MISSION_OUTCOMES, combineOutcomes, isBrokenRun, worstOutcome } from "@jevitate/domain";
import { goalExitCode, missionExitCode } from "./mission-exit.js";

describe("mission outcome → exit code (owner ruling 1: a distinct code per outcome)", () => {
  it("keeps 0 clean / 1 defects and gives broken runs, hangs and intermittents their own codes", () => {
    expect(Object.fromEntries(MISSION_OUTCOMES.map((o) => [o, missionExitCode(o)]))).toEqual({
      clean: 0,
      "defects-found": 1,
      hang: 3,
      intermittent: 4,
      inconclusive: 2,
      crashed: 2,
    });
  });

  it("the goal mission keeps its assertion codes and adds the broken-run code", () => {
    expect(goalExitCode("succeeded")).toBe(0);
    expect(goalExitCode("exhausted")).toBe(1);
    expect(goalExitCode("blocked")).toBe(1);
    expect(goalExitCode("inconclusive")).toBe(2);
    expect(goalExitCode("crashed")).toBe(2);
  });

  it("a broken run dominates any finding and is never clean", () => {
    expect(worstOutcome("defects-found", "crashed")).toBe("crashed");
    expect(worstOutcome("clean", "inconclusive")).toBe("inconclusive");
    expect(combineOutcomes(["clean", "intermittent", "defects-found"])).toBe("defects-found");
    expect(combineOutcomes(["defects-found", "hang"])).toBe("hang");
    expect(combineOutcomes([])).toBe("clean");
    expect(isBrokenRun("crashed")).toBe(true);
    expect(isBrokenRun("inconclusive")).toBe(true);
    expect(isBrokenRun("clean")).toBe(false);
  });
});
