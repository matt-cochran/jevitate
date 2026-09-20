import type { Recording } from "@jevitate/recording";
import { flattenSteps } from "./risk.js";

/**
 * True iff any `fill`/`select` step (recursively into `forEach`) carries a
 * materialized, non-redacted secret value (`{ redacted: false, value }`)
 * rather than a `{ var }` reference or a `{ redacted: true, length }`
 * placeholder. Spec §9.7 requires secret REFERENCES only — a shared,
 * published, or imported Journey must never carry a real credential value.
 * Blocks on both the import side (run-gate) and the publish side.
 */
export function hasEmbeddedSecretValue(recording: Recording): boolean {
  const steps = flattenSteps(recording.pages.flatMap((p) => p.steps.map((rs) => rs.step)));
  for (const step of steps) {
    if (step.kind === "fill" || step.kind === "select") {
      const value = step.value as unknown;
      if (
        typeof value === "object" &&
        value !== null &&
        "redacted" in value &&
        (value as { redacted: unknown }).redacted === false
      ) {
        return true;
      }
    }
  }
  return false;
}
