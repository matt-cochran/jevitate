import type { Journey } from "./journey.js";

/**
 * Anchor rules (#293, #466): the checks `JourneySchema` runs over `metadata.anchors` in its
 * `superRefine`. This is the single place those rules live, so tightening them (#466: lowercase
 * `[a-z0-9._:-]{1,64}` names, named anchors on a job-linked Journey) changes only this file.
 *
 * Today's behaviour, unchanged: a name is a safe word of at most 100 characters that is never all
 * digits (`--at-step 3` is a step number), names are unique, and an anchor's step is one the
 * Journey has.
 */

/** An anchor name: a safe word that is never all digits (`--at-step 3` is a step number). */
export const ANCHOR_NAME_RE = /^(?![0-9]+$)[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** The longest anchor name accepted. */
export const ANCHOR_NAME_MAX = 100;

/** One anchor-rule violation: where (a path from the Journey root) and why. */
export interface AnchorRuleIssue {
  readonly path: ReadonlyArray<string | number>;
  readonly message: string;
}

/** Every anchor-rule violation in `journey` (empty when its anchors are fine or it has none). */
export function anchorRuleIssues(journey: Journey): AnchorRuleIssue[] {
  const anchors = journey.metadata.anchors ?? [];
  const issues: AnchorRuleIssue[] = [];
  anchors.forEach((a, i) => {
    if (a.name.length > ANCHOR_NAME_MAX) {
      issues.push({ path: ["metadata", "anchors", i, "name"], message: `anchor name: at most ${ANCHOR_NAME_MAX} characters` });
    } else if (!ANCHOR_NAME_RE.test(a.name)) {
      issues.push({ path: ["metadata", "anchors", i, "name"], message: "anchor name: letters, digits, . _ - (not all digits)" });
    }
  });
  if (new Set(anchors.map((a) => a.name)).size !== anchors.length) {
    issues.push({ path: ["metadata", "anchors"], message: "anchors: duplicate name" });
  }
  // #293: an anchor names a state the Journey reaches — its step must be one of the Journey's own.
  const steps = journey.recording.pages.reduce((n, p) => n + p.steps.length, 0);
  anchors.forEach((a, i) => {
    if (a.step > steps) {
      issues.push({
        path: ["metadata", "anchors", i, "step"],
        message: `anchor ${JSON.stringify(a.name)}: step ${a.step} is past the Journey's last step (${steps})`,
      });
    }
  });
  return issues;
}
