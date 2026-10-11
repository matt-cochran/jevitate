/**
 * #486: advisory slow-step reporting across the replays of one run. A Journey replayed more than once
 * in a run (a check suite's items, a campaign's jobs) whose step was slow the FIRST time and not slow
 * on the later replays is a cold start (a deploy waking up), reported as one `cold-start` note instead
 * of a slow-step item. Advisory only: nothing here touches an exit code.
 */
import { detectColdStart } from "@jevitate/explore";

/** One replay of a Journey: its id and the slow-step findings the replay measured (empty = fast). */
export interface JourneyReplaySlowness {
  readonly journey: string;
  readonly slowSteps: ReadonlyArray<{ readonly step: number; readonly check: string; readonly latencyMs: number }>;
}

export interface ColdStartNote {
  readonly kind: "cold-start";
  readonly journey: string;
  readonly step: number;
  readonly check: string;
  /** The slow first replay's measured latency. */
  readonly firstLatencyMs: number;
  /** How many later replays of the Journey in the run were not slow on this step. */
  readonly laterReplaysFast: number;
}

export interface SlowStepNote {
  readonly kind: "slow-step";
  readonly journey: string;
  readonly step: number;
  readonly check: string;
  readonly latencyMs: number;
}

export interface SlownessReport {
  readonly coldStarts: ColdStartNote[];
  readonly slowSteps: SlowStepNote[];
}

/** Groups `replays` (in run order) by Journey; cold-start steps leave the plain slow-step list. */
export function reportSlowness(replays: readonly JourneyReplaySlowness[]): SlownessReport {
  const byJourney = new Map<string, JourneyReplaySlowness[]>();
  for (const r of replays) byJourney.set(r.journey, [...(byJourney.get(r.journey) ?? []), r]);
  const coldStarts: ColdStartNote[] = [];
  const slowSteps: SlowStepNote[] = [];
  for (const [journey, runs] of byJourney) {
    const key = (s: { step: number; check: string }): string => `${s.step}\u0000${s.check}`;
    const cold = detectColdStart(runs.map((r) => r.slowSteps.map((s) => ({ kind: "slow-step" as const, check: key(s), latencyMs: s.latencyMs }))));
    const coldKeys = new Set(cold.map((c) => c.check));
    for (const s of runs[0]?.slowSteps ?? []) {
      if (coldKeys.has(key(s))) coldStarts.push({ kind: "cold-start", journey, step: s.step, check: s.check, firstLatencyMs: s.latencyMs, laterReplaysFast: runs.length - 1 });
    }
    runs.forEach((r) => {
      for (const s of r.slowSteps) if (!coldKeys.has(key(s)) || r !== runs[0]) slowSteps.push({ kind: "slow-step", journey, step: s.step, check: s.check, latencyMs: s.latencyMs });
    });
  }
  return { coldStarts, slowSteps };
}
