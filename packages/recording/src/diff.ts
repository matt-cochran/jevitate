import { z } from "zod";
import type { Recording } from "./schema.js";
import { RecordingSchema } from "./schema.js";
import { alignTraces } from "./align.js";
import type { AlignedColumn } from "./align.js";
import { classifyColumns } from "./classify.js";
import type { ColumnClass, DiffResult } from "./classify.js";
import { promoteToVariable } from "./promote.js";
import type { StepRef } from "./promote.js";

/**
 * Structurally identical to `@jevitate/recorder`'s `AuthoringRecording` —
 * declared locally (not imported) because `@jevitate/recorder` depends on
 * `@jevitate/recording`, and importing the other way would create a circular
 * package/project-reference cycle. TypeScript's structural typing makes a
 * real `@jevitate/recorder` `AuthoringRecording` value assignable here with
 * zero adapter code.
 */
export interface AuthoringRecording {
  recording: Recording;
  values: Map<string, string>;
}

/**
 * The canonical schema for one "take file" on disk: a JSON object with a
 * schema-valid `Recording` and its captured authoring `values`, keyed
 * `` `${pageIndex}:${stepIndexInPage}` `` per `AuthoringRecording`'s
 * convention (see above) — but as a plain JSON object/record here, not a
 * `Map` (JSON has no Map literal; callers convert via
 * `new Map(Object.entries(parsed.values))` after parsing).
 *
 * `.strict()` (matching `RecordingSchema`'s own nested-object convention)
 * rejects unknown keys, and `values` is REQUIRED (not `.optional()` /
 * `.default({})`) — a take file must explicitly declare its values, even if
 * genuinely empty (`{}` is a valid explicit value; a missing `values` key is
 * not). This is deliberately fail-closed: a missing/malformed `values` field
 * must reject the whole take file rather than silently falling back to an
 * empty map, which would make `diffTakes` classify every column as
 * `"constant"` with full confidence — the single worst possible wrong answer
 * for a feature whose entire job is detecting variables.
 *
 * This is the ONE canonical definition of the take-file shape; callers that
 * read/write take files (the CLI's `recording diff` command, and this
 * package's own tests) should validate/build against it rather than
 * hand-rolling the `{recording, values}` shape themselves.
 */
export const AuthoringTakeSchema = z
  .object({
    recording: RecordingSchema,
    values: z.record(z.string(), z.string()),
  })
  .strict();

/**
 * Composes signature -> align -> classify over N authoring takes of "the
 * same" flow: aligns the takes' recordings (Task 5's `alignTraces`), then
 * classifies each aligned column (Task 6's `classifyColumns`) using each
 * take's captured authoring values.
 *
 * `classifyColumns` requires each take's `values` keyed by FLAT step index
 * (stringified 0-based position in `pages.flatMap(p => p.steps)` — see
 * `classify.ts`'s doc comment), but `AuthoringRecording.values` (Task 1) is
 * keyed `` `${pageIndex}:${stepIndexInPage}` ``. This function re-keys each
 * take's map from the latter convention to the former by walking that
 * take's own `pages`/`steps` with a running flat-index counter, in the
 * SAME order as `takes`, before handing off to `classifyColumns`.
 *
 * Pure: no I/O, no randomness, no mutation of any input.
 */
export function diffTakes(takes: AuthoringRecording[]): DiffResult {
  const recordings = takes.map((t) => t.recording);
  const cols = alignTraces(recordings);
  const reKeyedValues = takes.map((take) => reKeyToFlatIndex(take));
  return classifyColumns(cols, reKeyedValues);
}

/**
 * Re-keys one take's `values` map from Task 1's `"pageIndex:stepIndexInPage"`
 * convention to the flat-index (`"${flatIndex}"`) convention `classifyColumns`
 * requires, by walking `take.recording.pages` with a running flat-index
 * counter and looking up each step's original page/step-in-page key.
 */
function reKeyToFlatIndex(take: AuthoringRecording): Map<string, string> {
  const reKeyed = new Map<string, string>();
  let flatIndex = 0;
  take.recording.pages.forEach((page, pageIdx) => {
    page.steps.forEach((_step, stepIdxInPage) => {
      const original = take.values.get(`${pageIdx}:${stepIdxInPage}`);
      if (original !== undefined) {
        reKeyed.set(String(flatIndex), original);
      }
      flatIndex++;
    });
  });
  return reKeyed;
}

/**
 * Confidence threshold above which a `"variable"`-classified column is
 * treated as CONFIRMED to vary across takes (rather than a low-confidence
 * guess). Shared with `postdoc.ts`'s varied-value materialization guard —
 * see `applyPostdoc`'s doc comment for why the same threshold applies there.
 */
export const CONFIDENT_VARIABLE_THRESHOLD = 0.6;

/**
 * One fill/select step of `base`, flattened out with its `{page, step}` ref
 * preserved (refs are needed since `promoteToVariable` addresses steps by
 * page/step-in-page index, not flat index).
 */
export interface BaseFillStep {
  ref: StepRef;
  variableName: string | undefined;
}

interface DiffFillColumn {
  originalIndex: number;
  columnClass: ColumnClass;
}

/**
 * Auto-promotes each confident-variable column of `diff` to a `{var}` slot
 * on `base`, via `promoteToVariable`, leaving constant/noise/ambiguous/
 * low-confidence-variable columns' steps completely untouched. Returns a
 * new, schema-valid, parameterized, replayable Recording; `base` is never
 * mutated.
 *
 * **Precondition (not verified here — see below):** `base` must be
 * `takes[0].recording` from the SAME `diffTakes(takes)` call that produced
 * `diff` — i.e. the first take in whatever array was passed to `diffTakes`.
 * `DiffResult` itself carries no page/step refs back to any particular
 * Recording, so `applyDiff` cannot verify this from its declared inputs
 * alone; callers are responsible for passing a matching pair. When the
 * precondition holds, every genuine fill/select step of `base` has a
 * corresponding non-null `diff.columns[c].values[0]` entry (Task 1's
 * authoring-values contract guarantees take 0's captured value is present
 * for every fill/select step), which is exactly the correlation this
 * function relies on to zip `base`'s fill/select steps to `diff`'s
 * variable-bearing columns 1:1, in order. If the two derived lists don't
 * come out the same length, that's a caller-contract violation (the wrong
 * `base` was passed), and this function throws rather than silently
 * truncating or guessing at a correlation.
 *
 * `names`, when given, maps a `diff.columns` INDEX (not a zip position) to
 * an explicit variable name to use instead of the default
 * `` `${inferredType ?? "value"}${suffix}` `` naming. Caller-supplied names
 * are trusted as-is (not deduped against each other or against
 * default-named columns) — see the doc comment on `pickVarName` below for
 * why.
 *
 * **Known limitation — CONSTANT fill/select columns are not independently
 * replayable (unresolved, flagged for a future plan):** real recorder
 * output ALWAYS redacts fill/select values (`{redacted:true,length}` —
 * never `{redacted:false,value}`, per the recorder's own privacy posture).
 * A column this function classifies as `"constant"` (or leaves untouched
 * for any other non-promoted reason — noise, ambiguous, low-confidence
 * variable) is left completely untouched on `base`, so its step stays
 * `{redacted:true}` in the returned `Recording`. `@jevitate/interpreter`'s
 * `run-step.ts` throws `"cannot fill with a redacted constant value"` when
 * it hits such a step during replay — so this function's output is only
 * genuinely independently replayable when EVERY fill/select column in
 * `diff` was promoted to a `{var}` (i.e. every one was a confident
 * variable). This is NOT true in general — e.g. a login flow with one
 * constant "remember me" checkbox alongside a variable username field
 * produces an output whose "remember me" step cannot be replayed as-is.
 *
 * This tension is deliberate and UNRESOLVED, not a bug fixed here: the
 * design spec (§6) says a corroborated constant should be "fixed in the
 * artifact," while the plan's Global Constraint says the persisted/
 * parameterized artifact must never carry example values. The controller
 * has ruled this is a decision for a future plan (RxD Phase A.3b) to make
 * explicitly — whether a constant corroborated across a human's OWN
 * multiple takes (a materially different privacy posture than a single
 * captured value) may ever be materialized into the artifact, or whether
 * every fill/select column must instead be forced into a variable (with
 * some default) regardless of confidence. `applyDiff`'s behavior here is
 * unchanged pending that decision — this paragraph is documentation only.
 *
 * Pure: no clock/random/I/O.
 */
export function applyDiff(
  base: Recording,
  diff: DiffResult,
  names?: Record<number, string>,
): Recording {
  const baseFillSteps = flattenBaseFillSteps(base);
  const diffFillColumns = diff.columns
    .map((columnClass, originalIndex) => ({ columnClass, originalIndex }))
    .filter(({ columnClass }) => columnClass.values[0] !== null);

  if (baseFillSteps.length !== diffFillColumns.length) {
    throw new Error(
      `applyDiff: base has ${baseFillSteps.length} fill/select step(s) but diff has ` +
        `${diffFillColumns.length} value-bearing column(s) for take 0 — base must be the ` +
        `first take passed to the diffTakes(...) call that produced this diff`,
    );
  }

  const usedNames = new Set<string>();
  let currentRecording = base;

  for (let k = 0; k < baseFillSteps.length; k++) {
    const { ref } = baseFillSteps[k];
    const { columnClass, originalIndex } = diffFillColumns[k];

    if (columnClass.kind !== "variable" || columnClass.confidence < CONFIDENT_VARIABLE_THRESHOLD) {
      continue;
    }

    const varName = pickVarName(columnClass, originalIndex, names, usedNames);
    usedNames.add(varName);
    currentRecording = promoteToVariable(currentRecording, ref, varName);
  }

  return currentRecording;
}

/**
 * Flattens `base`'s pages/steps and keeps only the fill/select steps, in
 * order, each paired with its `{page, step}` ref — `promoteToVariable`
 * addresses a step by that ref, not by flat index, so refs must be tracked
 * while flattening (same page/step-in-page-index pattern used elsewhere in
 * this codebase, e.g. `classify.ts`'s flat-index walk).
 *
 * Exported so `postdoc.ts`'s varied-value materialization guard can reuse
 * this exact walk to correlate a single target step to its diff column,
 * rather than duplicating it.
 */
export function flattenBaseFillSteps(base: Recording): BaseFillStep[] {
  const result: BaseFillStep[] = [];
  base.pages.forEach((page, pageIdx) => {
    page.steps.forEach((recordedStep, stepIdxInPage) => {
      if (recordedStep.step.kind === "fill" || recordedStep.step.kind === "select") {
        result.push({
          ref: { page: pageIdx, step: stepIdxInPage },
          variableName: recordedStep.variableName,
        });
      }
    });
  });
  return result;
}

/**
 * Picks the variable name for one promoted column.
 *
 * Caller-supplied names (`names[originalIndex]`) are trusted AS-IS — not
 * deduped against anything else — on the judgment that an explicit name is
 * an intentional authoring decision; a caller who deliberately reuses a
 * name (e.g. binding two columns to the same variable on purpose) should
 * not have that overridden. It IS still added to `usedNames` so a
 * later-default-named column won't collide with it.
 *
 * A default name is `` `${inferredType ?? "value"}${suffix}` ``, where
 * `suffix` is `""` for that base name's first use anywhere in this
 * `applyDiff` call, and `"2"`, `"3"`, ... on each subsequent collision —
 * scoped across the WHOLE diff via the shared `usedNames` set, so two
 * promoted columns never silently share a name.
 */
function pickVarName(
  columnClass: ColumnClass,
  originalIndex: number,
  names: Record<number, string> | undefined,
  usedNames: Set<string>,
): string {
  const explicit = names?.[originalIndex];
  if (explicit !== undefined) {
    return explicit;
  }

  const baseName = columnClass.inferredType ?? "value";
  if (!usedNames.has(baseName)) {
    return baseName;
  }
  let n = 2;
  while (usedNames.has(`${baseName}${n}`)) {
    n++;
  }
  return `${baseName}${n}`;
}
