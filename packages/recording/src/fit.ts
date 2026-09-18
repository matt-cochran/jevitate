import type { InteractionPolicy } from "@doit/domain";
import type { Recording, RecordedStep, ValueOrVar } from "./schema.js";

/**
 * Derives an `InteractionPolicy` (humanization pacing model) from a
 * `Recording`'s captured `StepTiming`s, so a later replay can pace itself
 * like the human demonstrator did.
 *
 * `@doit/domain` is imported `import type` ONLY, never at runtime — see
 * `packages/recording/package.json` (a `devDependency`, not a runtime
 * `dependency`) and `packages/recording/tsconfig.json` (a project
 * `references` entry so `tsc --build` can resolve the type). This keeps
 * `@doit/recording` a runtime leaf package (no playwright/domain at
 * runtime); the type import is fully erased at build.
 *
 * Pure and deterministic: no clock, no randomness, no I/O. Every number in
 * the result is derived solely from the `Recording`'s own `timing` fields.
 *
 * ## Schema-shape constraint driving every derivation below
 *
 * `RecordedStep.timing` (see `schema.ts`'s `StepTiming`) is ONE aggregate
 * `{ atMs, durationMs, gapBeforeMs }` per step — there is no per-keystroke
 * timing anywhere in the `Recording` schema. `durationMs` on a `fill`/
 * `select` step is the WHOLE step's elapsed time (first interaction to
 * blur/commit), not a list of inter-key intervals. Every "per-key"/"per-
 * word"/"per-sentence" number below is therefore a step-level aggregate
 * estimate, never a true intra-step measurement — that's a genuine
 * information ceiling of the `Recording` format, not an oversight.
 *
 * ## Deliberately OUT OF SCOPE (omitted, not defaulted)
 *
 * - `typing.wordPauseMs` / `typing.sentencePauseMs` / `typing.hesitation`:
 *   these need a per-word/per-sentence boundary signal within a single
 *   fill's keystroke stream. A `Recording` only ever records one aggregate
 *   `durationMs` for the whole fill, so there is no boundary signal to
 *   derive these from. Left absent (they're optional in the domain schema).
 * - `readingMsPerChar` / `maxReadingMs`: these need a signal for "how much
 *   text was on screen and read before acting" (e.g. page content length,
 *   a reading-specific gap distinct from general think-time). A
 *   `Recording` captures neither page text nor a reading-specific timing
 *   channel — `gapBeforeMs` conflates think time, reading time, and mouse
 *   travel indiscriminately. Rather than guess, these are omitted
 *   entirely. This is a genuine scope cut (see task brief / controller
 *   ruling), not an oversight.
 */
export function fitInteractionPolicy(rec: Recording): InteractionPolicy {
  const allSteps: RecordedStep[] = rec.pages.flatMap((p) => p.steps);

  // --- typing.charsPerSecond / typing.perKeyJitter ---
  //
  // For every fill/select step with timing and durationMs > 0, treat the
  // step's captured value length as "characters typed" and its durationMs
  // as "time spent typing them" to get one chars/sec sample per step.
  // charsPerSecond is the mean of those per-step rates; perKeyJitter is
  // their coefficient of variation (SD / mean), clamped to [0, 1] — a
  // step-level proxy for per-keystroke jitter, since no true per-keystroke
  // data exists in the schema (see module doc above).
  const stepRates: number[] = [];
  for (const rs of allSteps) {
    if (rs.step.kind !== "fill" && rs.step.kind !== "select") continue;
    if (!rs.timing || rs.timing.durationMs <= 0) continue;

    const length = valueLength(rs.step.value);
    if (length === null || length <= 0) continue;

    stepRates.push((1000 * length) / rs.timing.durationMs);
  }

  const hasTyping = stepRates.length > 0;
  const typing = hasTyping
    ? {
        charsPerSecond: mean(stepRates),
        perKeyJitter: clamp01(
          stepRates.length >= 2 ? sampleSd(stepRates) / mean(stepRates) : 0,
        ),
      }
    : undefined;

  // --- thinkBeforeActionMs: gapBeforeMs on click/navigate steps only ---
  const thinkGaps: number[] = [];
  for (const rs of allSteps) {
    if (rs.step.kind !== "click" && rs.step.kind !== "navigate") continue;
    if (!rs.timing) continue;
    thinkGaps.push(rs.timing.gapBeforeMs);
  }
  const hasThink = thinkGaps.length > 0;

  // --- interInteractionMs: gapBeforeMs on EVERY timed step, any kind ---
  const allGaps: number[] = [];
  for (const rs of allSteps) {
    if (!rs.timing) continue;
    allGaps.push(rs.timing.gapBeforeMs);
  }
  const hasInter = allGaps.length > 0;

  return {
    ...(hasTyping ? { typing: typing! } : {}),
    ...(hasThink
      ? { thinkBeforeActionMs: { mean: mean(thinkGaps), sd: sdOf(thinkGaps) } }
      : {}),
    ...(hasInter
      ? { interInteractionMs: { mean: mean(allGaps), sd: sdOf(allGaps) } }
      : {}),
    // readingMsPerChar / maxReadingMs deliberately omitted — see module doc.
  };
}

/** Length of a fill/select value's captured content, or null if unknown
 * (a `{ var: ... }` reference carries no length signal). */
function valueLength(v: ValueOrVar): number | null {
  if ("var" in v) return null;
  return v.redacted ? v.length : v.value.length;
}

function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

/** Sample standard deviation (n-1 denominator). Used for `perKeyJitter`'s
 * coefficient of variation with >=2 samples. */
function sampleSd(xs: number[]): number {
  const m = mean(xs);
  const variance = xs.reduce((acc, x) => acc + (x - m) ** 2, 0) / (xs.length - 1);
  return Math.sqrt(variance);
}

/**
 * SD for a `DistParams.sd`, using the population (n) denominator: with
 * exactly one sample there is no variance signal at all, so this returns 0
 * (rather than NaN from an n-1 divide-by-zero) — a deliberate, documented
 * choice of population over sample SD for these two Dist fields.
 */
function sdOf(xs: number[]): number {
  if (xs.length <= 1) return 0;
  const m = mean(xs);
  const variance = xs.reduce((acc, x) => acc + (x - m) ** 2, 0) / xs.length;
  return Math.sqrt(variance);
}

function clamp01(x: number): number {
  if (Number.isNaN(x)) return 0;
  return Math.min(1, Math.max(0, x));
}
