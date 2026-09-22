import type { Step, Assertion, Recording, PageSegment, RecordedStep } from "@jevitate/recording";
import { spliceRecording } from "@jevitate/recording";
import type { Actor } from "@jevitate/screenplay";

/**
 * Mirrors `@jevitate/sources`'s `classifyRisk`'s per-step-kind judgment
 * (`READ_ONLY_KINDS`), duplicated here rather than imported: `@jevitate/sources`
 * depends on `@jevitate/journey`/`@jevitate/recording`, and `@jevitate/runtime`
 * must stay upstream of `@jevitate/sources` in the dependency graph (runtime
 * executes what sources resolves), so importing from `@jevitate/sources`
 * here would invert that edge. Flagged as a deliberate, small duplication
 * (see this plan's Risks section) — a future refactor could lift both onto
 * one shared `@jevitate/recording` export.
 */
const READ_ONLY_STEP_KINDS = new Set<Step["kind"]>(["navigate", "waitFor", "extract", "assert"]);

/** §9a invariant #8's unconditional floor: true for every step kind that
 * is NOT in `READ_ONLY_STEP_KINDS` — never bypassed by any `SelfHealMode`. */
export function isWriteStep(step: Step): boolean {
  return !READ_ONLY_STEP_KINDS.has(step.kind);
}

/** The failing step's own postcondition, if it carries one — this is what a
 * scoped re-learn must reach. `waitFor` (a `state`, not an `Assertion`) and
 * `forEach` (a control-flow container) have none and can never be
 * self-healed via this mechanism. */
export function postconditionOf(step: Step): Assertion | undefined {
  switch (step.kind) {
    case "navigate":
    case "click":
    case "fill":
    case "select":
    case "upload":
    case "press":
    case "extract":
      return step.expect;
    case "assert":
      return step.check;
    default:
      return undefined;
  }
}

/** Flattens a Recording's pages into a page-then-step-ordered list of its
 * `Step`s — the same order `@jevitate/interpreter`'s `run`/`resumeFrom`
 * index into via their `at`/`fromIndex`. */
export function flattenRecording(rec: Recording): { step: Step }[] {
  return rec.pages.flatMap((p) => p.steps.map((s) => ({ step: s.step })));
}

/**
 * Extracts every step from `base` at or after `fromFlatIndex` (in flat
 * page-then-step order), re-flowed into `PageSegment[]` — the tail that
 * must survive a scoped repair unchanged. Mirrors `@jevitate/recorder`'s
 * `checkpointToSpliceAt` walk.
 */
export function extractTail(base: Recording, fromFlatIndex: number): PageSegment[] {
  const tail: PageSegment[] = [];
  let seen = 0;
  for (const page of base.pages) {
    const keep: RecordedStep[] = [];
    for (const step of page.steps) {
      if (seen >= fromFlatIndex) keep.push(step);
      seen++;
    }
    if (keep.length > 0) tail.push({ ...page, steps: keep });
  }
  return tail;
}

/** `{page, step}` position of the step AT `brokenFlatIndex` itself — the
 * splice point for `spliceRecording`'s `"replace-from"` mode, which drops
 * everything from that position onward. One less than
 * `@jevitate/recorder`'s `checkpointToSpliceAt` (which points just AFTER a
 * checkpoint step). */
function spliceAtBroken(base: Recording, brokenFlatIndex: number): { page: number; step: number } {
  let remaining = brokenFlatIndex;
  for (let page = 0; page < base.pages.length; page++) {
    const len = base.pages[page]!.steps.length;
    if (remaining < len) return { page, step: remaining };
    remaining -= len;
  }
  throw new Error(`spliceAtBroken: index ${brokenFlatIndex} out of range for a ${base.pages.reduce((n, p) => n + p.steps.length, 0)}-step recording`);
}

/**
 * Builds the healed `Recording`: `base` with the broken step (at
 * `brokenFlatIndex`) AND everything after it replaced by `healedSegment`'s
 * own pages followed by the ORIGINAL tail from `brokenFlatIndex + 1`
 * onward — so exactly one step is genuinely replaced and every step after
 * it is preserved unchanged. Composed entirely from `spliceRecording`'s
 * existing `"replace-from"` mode plus `extractTail`, rather than a new
 * splice mode.
 */
export function healRecording(base: Recording, brokenFlatIndex: number, healedSegment: Recording): Recording {
  const tail = extractTail(base, brokenFlatIndex + 1);
  const replacement: Recording = { ...healedSegment, pages: [...healedSegment.pages, ...tail] };
  const at = spliceAtBroken(base, brokenFlatIndex);
  return spliceRecording(base, at, replacement, "replace-from");
}

export interface SelfHealer {
  /**
   * Scoped re-learn of exactly one broken step: `actor` is already sitting
   * in the LIVE state right after the last-good step (the failed step's own
   * action never completed) — the healer drives from there to
   * `expectedPostcondition` and returns the newly-learned segment as a
   * `Recording` (its own pages, starting fresh from the current page — no
   * leading `navigate`, matching the recorder's start-from-state capture
   * convention). Returns `"not-healed"` (never throws for an ordinary
   * failure to re-learn) when it could not reach the postcondition within
   * its own bounds.
   */
  reLearnStep(args: {
    actor: Actor;
    brokenStep: Step;
    expectedPostcondition: Assertion;
    allowedOrigins?: readonly string[];
  }): Promise<{ outcome: "healed"; segment: Recording } | { outcome: "not-healed"; reason: string }>;
}
