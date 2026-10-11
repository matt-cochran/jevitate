import type { Journey, JourneyAnchor } from "./journey.js";

/**
 * Anchor rules (#293, #466), in two tiers.
 *
 * (a) STRUCTURAL — `anchorRuleIssues`, run by `JourneySchema`'s `superRefine`: a Journey that breaks
 * one does not load. Unchanged since #293 except that `:` is allowed after the first character (a
 * broader alphabet than the 0.10 name rule's, so names a prior release accepted still load): a name is
 * a safe word of at most 100 characters that is never all digits (`--at-step 3` is a step number),
 * names are unique, and an anchor's step is one the Journey has.
 *
 * (b) THE 0.10 RULES — `anchorLintIssues`, NEVER at parse time (#466 ruling: existing Journeys still
 * load and run). Lint and the review sheet report them as warnings with the fix; `journey promote`
 * enforces them (`enforce: true` → errors) on a new promotion and on a re-promotion whose content
 * changed beyond step ids. The rules: a lowercase `[a-z0-9][a-z0-9._-]{0,63}` name (the catalog
 * bundle v1 `anchorName`, #478); an anchor points at a
 * step the Journey has — by `stepId` when present, and when it also has a `step` number the two
 * agree; on a Journey whose steps have ids, the anchor carries its step's id (promote stamps it);
 * a Journey linked to a job names at least one anchor. The job-side references (`jobStep` names a
 * step of the linked job, `serves` names its desired outcomes) need the catalog: the CLI's
 * `journeyRefIssues` (catalog-refs.ts). `boundary` needs a `jobStep` — the schema refuses one without.
 */

/** An anchor name (structural): a safe word that is never all digits (`--at-step 3` is a step number). */
export const ANCHOR_NAME_RE = /^(?![0-9]+$)[A-Za-z0-9][A-Za-z0-9._:-]*$/;

/** The longest anchor name accepted at load (structural). */
export const ANCHOR_NAME_MAX = 100;

/** #466: the 0.10 anchor name rule — what a new or re-promoted Journey's anchors must match. */
export const ANCHOR_NAME_RULE_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** One structural anchor-rule violation: where (a path from the Journey root) and why. */
export interface AnchorRuleIssue {
  readonly path: ReadonlyArray<string | number>;
  readonly message: string;
}

/** Every STRUCTURAL anchor-rule violation in `journey` (parse-time; empty when fine or it has none). */
export function anchorRuleIssues(journey: Journey): AnchorRuleIssue[] {
  const anchors = journey.metadata.anchors ?? [];
  const issues: AnchorRuleIssue[] = [];
  anchors.forEach((a, i) => {
    if (a.name.length > ANCHOR_NAME_MAX) {
      issues.push({ path: ["metadata", "anchors", i, "name"], message: `anchor name: at most ${ANCHOR_NAME_MAX} characters` });
    } else if (!ANCHOR_NAME_RE.test(a.name)) {
      issues.push({ path: ["metadata", "anchors", i, "name"], message: "anchor name: letters, digits, . _ - : (not all digits)" });
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

/** #466: the 0.10 anchor rules (Journey-local; the catalog ones are the CLI's `journeyRefIssues`). */
export type AnchorRuleCode =
  /** The name is not lowercase `[a-z0-9][a-z0-9._-]{0,63}`. */
  | "anchor-name"
  /** `stepId` names no step of the Journey. */
  | "anchor-step-id"
  /** `stepId` and `step` name different steps. */
  | "anchor-step-mismatch"
  /** The Journey's steps have ids, the anchor does not carry its step's. */
  | "anchor-unstamped"
  /** A Journey linked to a job names no anchor. */
  | "job-anchors";

export const ANCHOR_RULE_CODES: readonly AnchorRuleCode[] = ["anchor-name", "anchor-step-id", "anchor-step-mismatch", "anchor-unstamped", "job-anchors"];

/** #466: one 0.10 anchor-rule problem — a warning on data as loaded, an error when a promotion enforces. */
export interface AnchorLintIssue {
  readonly code: AnchorRuleCode;
  readonly severity: "warning" | "error";
  /** Where in the Journey: `metadata.anchors[0].name`, `metadata.anchors`, … */
  readonly path: string;
  /** The 1-based step it concerns, when it concerns one. */
  readonly step?: number;
  readonly message: string;
  /** What to change so the rule holds. */
  readonly fix: string;
}

export interface AnchorLintOptions {
  /** A promotion that must comply: every issue is an `error`. Default: a `warning`. */
  readonly enforce?: boolean;
}

/** #466: a compliant spelling of an anchor name (lowercase, other characters → `-`, at most 64). */
export function suggestAnchorName(name: string): string {
  const s = name
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .slice(0, 64)
    .replace(/-+$/, "");
  return s === "" ? "anchor" : s;
}

function flatStepIds(journey: Journey): (string | undefined)[] {
  return journey.recording.pages.flatMap((p) => p.steps.map((s) => s.stepId));
}

/** #466: every 0.10 anchor-rule problem in `journey` (empty when it complies). Pure. */
export function anchorLintIssues(journey: Journey, opts: AnchorLintOptions = {}): AnchorLintIssue[] {
  const severity = opts.enforce === true ? "error" : "warning";
  const anchors = journey.metadata.anchors ?? [];
  const ids = flatStepIds(journey);
  const out: AnchorLintIssue[] = [];
  anchors.forEach((a, i) => {
    const at = `metadata.anchors[${i}]`;
    const own = ids[a.step - 1];
    if (!ANCHOR_NAME_RULE_RE.test(a.name)) {
      out.push({
        code: "anchor-name",
        severity,
        path: `${at}.name`,
        step: a.step,
        message: `anchor '${a.name}': a name is 1-64 of lowercase a-z, 0-9, . _ - and starts with a letter or digit`,
        fix: `rename it to '${suggestAnchorName(a.name)}' (and update any metric, mutation pair or campaign that names it)`,
      });
    }
    if (a.stepId !== undefined) {
      const index = ids.indexOf(a.stepId);
      if (index < 0) {
        out.push({
          code: "anchor-step-id",
          severity,
          path: `${at}.stepId`,
          step: a.step,
          message: `anchor '${a.name}': stepId '${a.stepId}' is not a step of the Journey`,
          fix: own === undefined ? `remove the stepId (the anchor follows step ${a.step})` : `set stepId to '${own}' (step ${a.step}), or point the anchor at the step it should follow`,
        });
      } else if (index + 1 !== a.step) {
        out.push({
          code: "anchor-step-mismatch",
          severity,
          path: `${at}.step`,
          step: a.step,
          message: `anchor '${a.name}': step ${a.step} and stepId '${a.stepId}' (step ${index + 1}) name different steps`,
          fix: `set step to ${index + 1} (stepId is authoritative), or set stepId to the id of step ${a.step}`,
        });
      }
    } else if (own !== undefined) {
      out.push({
        code: "anchor-unstamped",
        severity,
        path: `${at}.stepId`,
        step: a.step,
        message: `anchor '${a.name}' references step ${a.step} by number only — anchors reference steps by their stable step id`,
        fix: `set stepId to '${own}' (jevitate journey promote stamps it)`,
      });
    }
  });
  if (journey.metadata.job !== undefined && anchors.length === 0) {
    out.push({
      code: "job-anchors",
      severity,
      path: "metadata.anchors",
      message: `the Journey is linked to job '${journey.metadata.job}' but names no anchor — a job-linked Journey marks where the job's steps start and end`,
      fix: `add a named anchor, e.g. metadata.anchors: [{ "name": "<job-step>:end", "step": <n>, "jobStep": "<job step id>", "boundary": "end" }]`,
    });
  }
  return out;
}

/**
 * #466: the Journey with each anchor carrying the `stepId` of the step it follows (by its `step`
 * number), where that step has an id and the anchor has none. `step` is kept (the bundle contract
 * keys `link.anchors[].step` by it). The same object when nothing changes.
 */
export function stampAnchorStepIds(journey: Journey): Journey {
  const anchors = journey.metadata.anchors;
  if (anchors === undefined) return journey;
  const ids = flatStepIds(journey);
  let changed = false;
  const stamped = anchors.map((a): JourneyAnchor => {
    const id = ids[a.step - 1];
    if (a.stepId !== undefined || id === undefined) return a;
    changed = true;
    return { ...a, stepId: id };
  });
  return changed ? { ...journey, metadata: { ...journey.metadata, anchors: stamped } } : journey;
}

/** #466: the Journey without step ids — its steps' `stepId`s and its anchors' (to compare content beyond ids). */
export function stripStepIds(journey: Journey): Journey {
  const anchors = journey.metadata.anchors;
  return {
    ...journey,
    metadata: { ...journey.metadata, ...(anchors === undefined ? {} : { anchors: anchors.map(({ stepId: _id, ...rest }) => rest) }) },
    recording: {
      ...journey.recording,
      pages: journey.recording.pages.map((p) => ({ ...p, steps: p.steps.map(({ stepId: _id, ...rest }) => rest) })),
    },
  };
}
