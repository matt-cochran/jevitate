import type { Recording, RecordedStep } from "./schema.js";
import { alignTraces } from "./align.js";
import type { AlignedColumn } from "./align.js";

export interface ReferenceDiffResult {
  divergedAt: number | null;
  kind?: "missing" | "extra" | "changed";
  detail?: string;
}

/**
 * Localizes where an automated `run` first structurally departs from a
 * `reference` recording (a human demo, or the last-known-good take) — the
 * self-healing entry point: once localized, a healer only needs to look at
 * this one aligned position, not diff the whole flow by hand.
 *
 * Built directly on `alignTraces`'s two-take alignment (Task 5), whose
 * invariant is load-bearing here: a column's non-null cells always share
 * the identical `stepSignature`, or the column has exactly one non-null
 * cell (a gap). Two different-signature steps NEVER land in the same
 * column — so a literal "changed" divergence never appears as ONE aligned
 * column holding two different steps. Instead a substitution (run did step
 * X where reference expected step B, B != X) always shows up as TWO
 * adjacent columns: one where run has a step and reference has a gap, and
 * the very next one where reference has a step and run has a gap (or vice
 * versa, depending on which side the aligner's tie-breaking happens to
 * place first — see `needlemanWunsch`'s traceback comment in `align.ts`).
 * This function detects that adjacent opposite-gap pair and reports it as
 * a single `"changed"` event rather than two independent
 * `"missing"`/`"extra"` events.
 *
 * `cols[c].cells[0]` is always `run`'s cell and `cols[c].cells[1]` is
 * always `reference`'s cell at aligned position `c`, since `alignTraces`
 * is called as `alignTraces([run, reference])`.
 *
 * `divergedAt` is the 0-based index into the aligned column sequence. This
 * is well-defined as a flat step index for BOTH `run` and `reference`
 * because every column before the first divergence is "perfect" (both
 * cells present, therefore identical signature per the invariant above) —
 * so `run` and `reference` are in lockstep up to that point, and `c`
 * equals both sequences' own flat step index for everything strictly
 * before the divergence.
 *
 * Pure, deterministic: no I/O, no clock, no randomness — depends only on
 * the two input `Recording`s' content (via `alignTraces`).
 */
export function diffRecordings(run: Recording, reference: Recording): ReferenceDiffResult {
  return diffColumns(alignTraces([run, reference]));
}

/**
 * The column-level core of `diffRecordings`, split out so the adjacent-gap
 * collapse logic can be unit-tested directly against a hand-constructed
 * `AlignedColumn[]` — including the "missing-first" ordering exercised
 * below (a `[null, ref]` column immediately followed by a `[run, null]`
 * column). That ordering is logically handled and symmetric by
 * construction, but per code-review it could NOT be produced by any real
 * `alignTraces([run, reference])` call against today's `align.ts`: for a
 * substitution, `align.ts`'s own tie-break docstring on `needlemanWunsch`
 * (search "Deterministic tie-breaking") guarantees `a`'s leftover element
 * surfaces in its own column BEFORE `b`'s leftover element does — and here
 * `a` is always `run` (`alignTraces([run, reference])` passes `run` as
 * `sigTakes[0]`), so real output only ever produces "extra-first"
 * (`[run, null]` then `[null, ref]`), never "missing-first". This
 * function-level split keeps the "missing-first" branch below covered by a
 * direct test even though it's currently unreachable end-to-end via
 * `diffRecordings` — so a future change to `align.ts`'s tie-breaking can't
 * silently leave it broken and untested.
 */
export function diffColumns(cols: AlignedColumn[]): ReferenceDiffResult {
  const c = cols.findIndex((col) => !isPerfect(col));
  if (c === -1) return { divergedAt: null };

  const runCell = cols[c].cells[0];
  const refCell = cols[c].cells[1];
  const next = c + 1 < cols.length ? cols[c + 1] : undefined;

  if (runCell === null) {
    // reference has a step run is missing (refCell is non-null: a column
    // always has at least one non-null cell, and this one isn't "perfect").
    const referenceStep = refCell as RecordedStep;

    // Adjacent-pair check: does the very next column hold the opposite
    // gap pattern (run has a step, reference doesn't)? If so this is a
    // substitution, not an independent deletion. NOTE: per this file's
    // top-of-function doc comment, this "missing-first" sub-path is not
    // currently known to be reachable via real `alignTraces([run,
    // reference])` output (see `diffColumns`'s doc comment) — it's covered
    // only by a direct `diffColumns` unit test against a hand-built
    // `AlignedColumn[]`, not by any `diffRecordings` test.
    if (next && next.cells[0] !== null && next.cells[1] === null) {
      const runStep = next.cells[0];
      return {
        divergedAt: c,
        kind: "changed",
        detail: `run performed ${describeStep(runStep)} where reference expected ${describeStep(referenceStep)}`,
      };
    }

    return {
      divergedAt: c,
      kind: "missing",
      detail: `reference expected ${describeStep(referenceStep)}, but run does not have a matching step here`,
    };
  }

  // runCell !== null and the column isn't "perfect", so refCell is null:
  // run has a step reference doesn't expect at this position.
  const runStep = runCell;

  // Same adjacent-pair check, from the other side: does the next column
  // hold the opposite gap pattern (reference has a step, run doesn't)?
  if (next && next.cells[0] === null && next.cells[1] !== null) {
    const referenceStep = next.cells[1];
    return {
      divergedAt: c,
      kind: "changed",
      detail: `run performed ${describeStep(runStep)} where reference expected ${describeStep(referenceStep)}`,
    };
  }

  return {
    divergedAt: c,
    kind: "extra",
    detail: `run performed ${describeStep(runStep)}, which reference does not expect here`,
  };
}

function isPerfect(col: AlignedColumn): boolean {
  return col.cells[0] !== null && col.cells[1] !== null;
}

/** Short, human-readable diagnostic for a step, used only in `detail`. */
function describeStep(recordedStep: RecordedStep): string {
  const step = recordedStep.step;
  const target = "target" in step ? step.target : undefined;
  const ident = target ? (target.testId ?? target.role ?? target.label ?? target.css ?? target.text) : undefined;
  return ident ? `${step.kind}(${ident})` : step.kind;
}
