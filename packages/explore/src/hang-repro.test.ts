import { describe, expect, it } from "vitest";
import type { Recording } from "@jevitate/recording";
import { hangOutcome, recordCoverageHang, reproduceHang, reproductionStatus, type HangAttempt, type HangFinding } from "./hang-repro.js";
import type { HangSignal } from "./hang.js";
import type { VerifySession } from "./verify-fix.js";

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

describe("#87 — recordCoverageHang: a known hang (by fingerprint) is never re-reproduced", () => {
  it("the SAME global element hanging on three different routes spends replay budget once and lists every route", async () => {
    let opens = 0;
    const openSession = async (): Promise<VerifySession> => {
      opens += 1;
      throw new Error("no fresh session in this test");
    };
    const found = new Map<string, HangFinding>();
    const recording: Recording = { version: "1.0.0", site: "x", pages: [] };
    const base = {
      kind: "ui-no-progress" as const,
      detail: "a busy indicator never went away",
      url: "http://x.test",
      pending: [],
      lastState: { signature: "s", controls: [] },
      element: "[data-testid=global-progress]",
    };
    for (const route of ["/a", "/b", "/c"]) {
      await recordCoverageHang({ hang: { ...base, route }, recording, steps: [], found, openSession, attempts: 1 });
    }
    expect(found.size).toBe(1); // one finding — never one per route
    const finding = [...found.values()][0];
    expect(finding?.occurrences).toBe(3);
    expect(finding?.routes).toEqual(["/a", "/b", "/c"]);
    // Only the FIRST occurrence attempted reproduction; the 2nd and 3rd spent no replay budget
    // re-confirming the same element again.
    expect(opens).toBe(1);
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
