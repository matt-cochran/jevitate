import type { Journey } from "@jevitate/journey";
import type { SafetyConfig } from "@jevitate/explore";
import { loadTargetsFile, resolveTargetConfig } from "./target-config.js";

/** Recorded-origin classification authority, independent of the replay destination/session. */
export function journeyTargetSafety(journey: Journey, targetsFile?: string): SafetyConfig | undefined {
  let origin: string;
  try { origin = new URL(journey.recording.site).origin; } catch { return undefined; }
  const safety = resolveTargetConfig(loadTargetsFile(targetsFile), origin).safety;
  if (safety === undefined) return undefined;
  return { ...safety, ...(safety.readRequests === undefined ? {} : { readRequests: Object.freeze([...new Set(safety.readRequests)].sort()) }) };
}
