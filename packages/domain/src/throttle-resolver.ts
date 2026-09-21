import type { ThrottlePolicy } from "./interaction-policy.js";

export function resolveThrottle(layers: ThrottlePolicy[]): ThrottlePolicy {
  const out: ThrottlePolicy = {};
  for (const l of layers) {
    if (l.minIntervalSeconds !== undefined)
      out.minIntervalSeconds = Math.max(
        out.minIntervalSeconds ?? 0,
        l.minIntervalSeconds
      );
    if (l.hourlyLimit !== undefined)
      out.hourlyLimit = Math.min(out.hourlyLimit ?? Infinity, l.hourlyLimit);
    if (l.dailyLimit !== undefined)
      out.dailyLimit = Math.min(out.dailyLimit ?? Infinity, l.dailyLimit);
  }
  return out;
}
