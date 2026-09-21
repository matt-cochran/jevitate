import type { QuietHours, ThrottlePolicy } from "./interaction-policy.js";
import { isWithinQuietHours, nextOpenAfter } from "./quiet-hours.js";

export type GateDecision =
  | { kind: "proceed" }
  | { kind: "wait"; ms: number }
  | { kind: "throttled"; reason: "quiet_hours" | "min_interval"; retryAfter: string };

export function evaluateGate(input: {
  nowIso: string;
  resolved: ThrottlePolicy;
  lastAtIso: string | null;
  quietHours?: QuietHours;
  maxInlineWaitMs: number;
}): GateDecision {
  const { nowIso, resolved, lastAtIso, quietHours, maxInlineWaitMs } = input;

  if (quietHours !== undefined && isWithinQuietHours(nowIso, quietHours)) {
    return {
      kind: "throttled",
      reason: "quiet_hours",
      retryAfter: nextOpenAfter(nowIso, quietHours),
    };
  }

  if (resolved.minIntervalSeconds !== undefined && lastAtIso !== null) {
    const minIntervalMs = resolved.minIntervalSeconds * 1000;
    const elapsedMs = Date.parse(nowIso) - Date.parse(lastAtIso);
    const shortfallMs = Math.round(minIntervalMs - elapsedMs);

    if (shortfallMs > 0) {
      if (shortfallMs <= maxInlineWaitMs) {
        return { kind: "wait", ms: shortfallMs };
      }
      return {
        kind: "throttled",
        reason: "min_interval",
        retryAfter: new Date(Date.parse(lastAtIso) + minIntervalMs).toISOString(),
      };
    }
  }

  return { kind: "proceed" };
}
