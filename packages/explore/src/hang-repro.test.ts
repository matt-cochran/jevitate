import { describe, expect, it } from "vitest";
import { hangOutcome, reproduceHang, reproductionStatus, type HangAttempt } from "./hang-repro.js";
import type { HangSignal } from "./hang.js";

/** Replays that never ran are not evidence of anything (coordinator ruling, round 2d). */

const hang: HangSignal = {
  kind: "main-thread-unresponsive",
  detail: "probe missed",
  route: "/x",
  url: "http://x.test/x",
  pending: [],
  lastState: { signature: "s", controls: [] },
};

const attempt = (reproduced: boolean, ran: boolean): Pick<HangAttempt, "reproduced" | "ran"> => ({ reproduced, ran });

describe("reproductionStatus — only attempts that RAN count", () => {
  it.each<[string, Array<Pick<HangAttempt, "reproduced" | "ran">>, string]>([
    ["2/2 reproduced", [attempt(true, true), attempt(true, true)], "reproduced"],
    ["1 reproduced, 1 never ran → confirmed (k ≥ 1)", [attempt(true, true), attempt(false, false)], "reproduced"],
    ["1 reproduced, 1 ran clean → confirmed (k ≥ 1)", [attempt(true, true), attempt(false, true)], "reproduced"],
    ["0 reproduced, one ran fully → intermittent", [attempt(false, true), attempt(false, false)], "intermittent"],
    ["no attempt ran → inconclusive, NOT a non-reproduction", [attempt(false, false), attempt(false, false)], "inconclusive"],
    ["nothing attempted → inconclusive", [], "inconclusive"],
  ])("%s", (_name, runs, want) => {
    expect(reproductionStatus(runs)).toBe(want);
  });

  it("maps to mission outcomes: reproduced → hang, intermittent → intermittent, inconclusive → inconclusive", () => {
    expect(hangOutcome("reproduced")).toBe("hang");
    expect(hangOutcome("intermittent")).toBe("intermittent");
    expect(hangOutcome("inconclusive")).toBe("inconclusive");
  });
});

describe("reproduceHang — a replay that could not execute is not a non-reproduction", () => {
  it("fresh sessions that cannot open (e.g. admission timed out under memory pressure) → inconclusive, 0 ran", async () => {
    const r = await reproduceHang({
      recording: { version: "1.0.0", site: "x", pages: [] },
      recordingStepIndex: 0,
      hang,
      attempts: 2,
      openSession: async () => {
        throw new Error("admission timed out after 300000ms: memory pressure full avg10=7.25% > 5%");
      },
    });
    expect(r).toMatchObject({ attempts: 2, ran: 0, reproduced: 0, status: "inconclusive" });
    expect(r.runs.every((run) => !run.ran && run.detail.startsWith("could not open a fresh session: admission timed out"))).toBe(true);
  });
});
