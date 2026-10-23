import type { DesiredOutcome } from "@jevitate/journey";
import type { CheckBaseline } from "./check-types.js";

/**
 * #643 (owner decision, jtbd-data-model §8.2: "Jevitate reports target misses by default"): a job's
 * desired-outcome targets against ONE clean replay's machine baseline (#469). Pure — no I/O, no clock.
 *
 * A clean replay is the fastest path the app allows, so its time between a duration metric's anchors
 * is a floor no person goes below. The test is one-sided:
 *  - `miss`: the floor already breaks the target — no user can meet it (a p50/p75 upper bound in
 *    seconds the floor exceeds, or a `share_under` threshold the floor exceeds while the target wants
 *    some share under it);
 *  - `not-decidable`: the floor meets the target — whether people do is Journeeze's to measure;
 *  - `unmeasured`: an anchor the metric names is not in the baseline;
 *  - `not-decidable-by-replay`: no duration metric, no target, or a lower-bound target.
 * Advisory: it never gates a run.
 */

export type OutcomeTargetStatus = "miss" | "not-decidable" | "unmeasured" | "not-decidable-by-replay";

export interface OutcomeTargetResult {
  readonly outcomeId: string;
  readonly status: OutcomeTargetStatus;
  /** Seconds between the metric's anchors on the replay, when both resolved. */
  readonly floorSeconds?: number;
  /** The target as written: `op value unit`. */
  readonly target?: string;
  readonly reason: string;
}

export function evaluateOutcomeTargets(outcomes: readonly DesiredOutcome[], baseline: CheckBaseline): OutcomeTargetResult[] {
  return outcomes.map((o) => evaluateOne(o, baseline));
}

function evaluateOne(o: DesiredOutcome, baseline: CheckBaseline): OutcomeTargetResult {
  const metric = o.metric;
  const target = o.target;
  if (metric === undefined || target === undefined) {
    return { outcomeId: o.id, status: "not-decidable-by-replay", reason: "no metric or no target" };
  }
  const written = `${target.op} ${target.value} ${target.unit}`;
  if (metric.kind !== "duration") {
    return { outcomeId: o.id, status: "not-decidable-by-replay", target: written, reason: `a ${metric.kind} metric needs real users, not a replay` };
  }
  const at = (name: string): number | undefined => baseline.anchors.find((a) => a.name === name)?.atMs;
  const from = at(metric.from);
  const to = at(metric.to);
  const missing = from === undefined ? metric.from : to === undefined ? metric.to : null;
  if (missing !== null || from === undefined || to === undefined) {
    return { outcomeId: o.id, status: "unmeasured", target: written, reason: `anchor '${missing}' is not in the replay's baseline` };
  }
  const floorSeconds = Math.max(0, to - from) / 1000;
  const floor = `the replay took ${floorSeconds}s from '${metric.from}' to '${metric.to}'`;
  if (metric.stat === "share_under") {
    // A share of people finishing under `threshold` seconds: none can when the floor is over it.
    const wantsShare = (target.op === ">" || target.op === ">=") && target.unit === "percent" && target.value > 0;
    if (!wantsShare || metric.threshold === undefined) {
      return { outcomeId: o.id, status: "not-decidable-by-replay", floorSeconds, target: written, reason: "only a lower bound on the share under a threshold is decidable" };
    }
    return metric.threshold < floorSeconds
      ? { outcomeId: o.id, status: "miss", floorSeconds, target: written, reason: `${floor}, over the ${metric.threshold}s threshold: no one finishes under it` }
      : { outcomeId: o.id, status: "not-decidable", floorSeconds, target: written, reason: `${floor}, within the ${metric.threshold}s threshold` };
  }
  if (target.unit !== "s" || (target.op !== "<" && target.op !== "<=")) {
    return { outcomeId: o.id, status: "not-decidable-by-replay", floorSeconds, target: written, reason: "only an upper bound in seconds is decidable" };
  }
  const breaks = target.op === "<" ? floorSeconds >= target.value : floorSeconds > target.value;
  return breaks
    ? { outcomeId: o.id, status: "miss", floorSeconds, target: written, reason: `${floor}: the fastest path already breaks ${written}` }
    : { outcomeId: o.id, status: "not-decidable", floorSeconds, target: written, reason: `${floor}, within ${written}` };
}
