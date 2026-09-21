import { z } from "zod";
import type { Recording, RecordedStep, PageSegment, Step, Assertion } from "./schema.js";
import { RecordingSchema } from "./schema.js";
import type { AuthoringRecording } from "./diff.js";
import { flattenBaseFillSteps, CONFIDENT_VARIABLE_THRESHOLD } from "./diff.js";
import type { DiffResult } from "./classify.js";
import { promoteToVariable } from "./promote.js";
import type { StepRef } from "./promote.js";

/**
 * Thrown by `applyPostdoc` whenever a `"constant"` decision would materialize
 * a value that must never become a literal in the persisted artifact:
 *
 * - No local authoring value is available for the target step at all — a
 *   defense-in-depth fail-closed signal. In practice the recorder emits a
 *   secret/PII field as a `handback` step, NOT a fill/select, so a genuine
 *   secret never reaches this constant-materialization path as a fill in the
 *   first place; this guard catches any fill/select step that nonetheless
 *   arrives without a captured authoring value. There is no separate
 *   schema-level `sensitive`/`redacted` flag on `RedactedValue` beyond the
 *   presence/absence of a captured `value`, so this absence check is the
 *   whole schema-level secrecy signal on the postdoc side (see
 *   `materializeConstant` below).
 * - The target step's value VARIED across the takes that produced `diff`
 *   (a confident `"variable"` column) and the decision did not explicitly
 *   set `acknowledgeVaried: true` to override that guard.
 *
 * Floor #6 (design spec): a secret value must never become a literal
 * constant. This class exists so callers can distinguish this specific,
 * load-bearing failure mode from any other error `applyPostdoc` might throw
 * (out-of-range refs, wrong step kind, schema validation, ...).
 */
export class SecretMaterializationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecretMaterializationError";
  }
}

/**
 * One human decision made during postdoc review about a single fill/select
 * (or, for `"handback"`, any) step: how to classify its captured value, plus
 * optional cosmetic annotations.
 *
 * - `"constant"` — materialize the LOCAL authoring value (never a value sent
 *   to a model) as a literal, but ONLY when non-secret AND non-varied
 *   (Task 5: "non-secret" means an authoring value is actually available for
 *   this step; Task 6's `SecretMaterializationError` formalizes the full
 *   secrecy guard AND adds the "value varied across takes" guard —
 *   `acknowledgeVaried: true` explicitly overrides the latter, never the
 *   former).
 * - `"variable"` — promote the step's value to a `{var: name}` slot via
 *   A.3a's `promoteToVariable`.
 * - `"handback"` — convert the step into a `handback` step: the human takes
 *   over at replay time instead of an automated action.
 *
 * `label`/`chunk` are applied regardless of `classify` — `label` sets the
 * resulting step's own `label` field; `chunk` tags the `RecordedStep` with a
 * human-assigned higher-level "chunk" (Screenplay Task/Action) name for
 * later grouping (see `RecordedStep.chunk` in `schema.ts`).
 *
 * `acknowledgeVaried` lives ONLY on this in-memory decision input — it is
 * never persisted into the `Recording` artifact (nothing in `schema.ts`
 * carries it), so it does not touch the closed-schema guardrail.
 */
export type PostdocDecision = { step: StepRef } & (
  | { classify: "constant"; acknowledgeVaried?: true }
  | { classify: "variable"; name: string }
  | { classify: "handback"; prompt: string }
) & { label?: string; chunk?: string };

/**
 * zod schema for `StepRef` (not exported elsewhere in the package today —
 * this is the only place a `StepRef` needs to be parsed from untrusted
 * input). `.strict()` to fail closed on unknown keys, matching the rest of
 * this package's closed-schema posture.
 */
const StepRefSchema = z
  .object({
    page: z.number().int().nonnegative(),
    step: z.number().int().nonnegative(),
  })
  .strict();

/**
 * CLI-INPUT schema for `PostdocDecision`, matching its in-memory type
 * EXACTLY: a discriminated union on `classify`, each variant `.strict()` to
 * fail closed on unknown keys.
 *
 * This is a schema for parsing a `--decisions <file>` JSON array fed to the
 * `recording postdoc` CLI (Task 7) — it is NOT part of the `Recording`
 * artifact and never touches `RecordingSchema`'s closed-schema guardrail.
 * `acknowledgeVaried`, in particular, is validated here purely so the CLI
 * can fail closed on a malformed decisions file; it is still never
 * persisted into a `Recording` (see `PostdocDecision`'s doc comment above).
 */
export const PostdocDecisionSchema = z.discriminatedUnion("classify", [
  z
    .object({
      step: StepRefSchema,
      classify: z.literal("constant"),
      acknowledgeVaried: z.literal(true).optional(),
      label: z.string().optional(),
      chunk: z.string().optional(),
    })
    .strict(),
  z
    .object({
      step: StepRefSchema,
      classify: z.literal("variable"),
      name: z.string(),
      label: z.string().optional(),
      chunk: z.string().optional(),
    })
    .strict(),
  z
    .object({
      step: StepRefSchema,
      classify: z.literal("handback"),
      prompt: z.string(),
      label: z.string().optional(),
      chunk: z.string().optional(),
    })
    .strict(),
]);

/**
 * An array of `PostdocDecisionSchema` — the shape `recording postdoc
 * --decisions <file>` reads from disk.
 */
export const PostdocDecisionsSchema = z.array(PostdocDecisionSchema);

/**
 * Turns one authoring take + the A.3a diff + a list of explicit human
 * decisions into a parameterized `Recording`.
 *
 * Only steps named by a decision are touched. A fill/select step with NO
 * decision is left completely untouched — still whatever `authoring`
 * captured it as (in practice, real recorder output redacts it:
 * `{redacted:true,length}`). This is deliberate and fail-closed: nothing is
 * ever materialized (as a constant OR promoted to a variable) without an
 * explicit decision.
 *
 * **Precondition on `diff` (same as `applyDiff`'s — see diff.ts):**
 * `authoring` must be `takes[0]` of the SAME `diffTakes(takes)` call that
 * produced `diff`. A `constant` decision consults `diff` (Task 6's
 * varied-value guard, below) by correlating the target step's position
 * among `authoring.recording`'s flattened fill/select steps to the
 * same-position value-bearing column of `diff.columns` — this correlation
 * is only meaningful under that precondition, exactly as `applyDiff`
 * documents at diff.ts:122-136.
 *
 * Decisions are applied in array order; `label`/`chunk`, when present on a
 * decision, are applied to the SAME step right after its `classify` action
 * (so e.g. a `"handback"` decision's `label` overrides the label the new
 * handback step would otherwise inherit from the original step).
 *
 * Pure: no I/O, no clock/randomness; `authoring.recording` is never mutated
 * (every helper below clones the path from root to the target step, the
 * same pattern `promoteToVariable` uses).
 *
 * @throws `SecretMaterializationError` if a `constant` decision targets a
 *   step with no local authoring value (the fail-closed signal for a
 *   secret/PII field), or targets a step whose value CONFIDENTLY VARIED
 *   across the takes behind `diff` without `acknowledgeVaried: true` on the
 *   decision.
 * @throws a plain `Error` for any other misuse: a non-fill/select step
 *   targeted by a `constant` decision, an out-of-range `step` ref, or a
 *   `diff` that does not correlate with `authoring` (precondition
 *   violation).
 */
export function applyPostdoc(
  authoring: AuthoringRecording,
  diff: DiffResult,
  decisions: PostdocDecision[],
): Recording {
  let current = authoring.recording;

  for (const decision of decisions) {
    const ref = decision.step;

    if (decision.classify === "variable") {
      current = promoteToVariable(current, ref, decision.name);
    } else if (decision.classify === "constant") {
      current = materializeConstant(current, authoring, diff, ref, decision.acknowledgeVaried === true);
    } else {
      current = convertToHandback(current, ref, decision.prompt);
    }

    if (decision.label !== undefined) {
      current = applyLabel(current, ref, decision.label);
    }
    if (decision.chunk !== undefined) {
      current = applyChunk(current, ref, decision.chunk);
    }
  }

  return current;
}

// === Internal helpers ===
// All share `promoteToVariable`'s clone-the-path-to-the-target-step pattern
// and re-validate the result against `RecordingSchema` before returning, so
// a bug here can never produce a schema-invalid `Recording`.

function getStepBounds(rec: Recording, ref: StepRef): { page: PageSegment } {
  if (ref.page < 0 || ref.page >= rec.pages.length) {
    throw new Error(`Page index ${ref.page} out of range (0-${rec.pages.length - 1})`);
  }
  const page = rec.pages[ref.page];
  if (ref.step < 0 || ref.step >= page.steps.length) {
    throw new Error(`Step index ${ref.step} out of range (0-${page.steps.length - 1})`);
  }
  return { page };
}

function getRecordedStepAt(rec: Recording, ref: StepRef): RecordedStep {
  const { page } = getStepBounds(rec, ref);
  return page.steps[ref.step];
}

function setStepAt(rec: Recording, ref: StepRef, newRecordedStep: RecordedStep): Recording {
  getStepBounds(rec, ref);

  const newPages: PageSegment[] = rec.pages.map((p, pageIdx) => {
    if (pageIdx !== ref.page) return p;
    const newSteps: RecordedStep[] = p.steps.map((s, stepIdx) =>
      stepIdx !== ref.step ? s : newRecordedStep,
    );
    return { ...p, steps: newSteps };
  });

  const newRecording: Recording = { ...rec, pages: newPages };
  const validation = RecordingSchema.safeParse(newRecording);
  if (!validation.success) {
    throw new Error(`Recording validation failed: ${validation.error.message}`);
  }
  return validation.data;
}

/**
 * Materializes a `constant` decision: replaces the target fill/select
 * step's value with a LITERAL built from `authoring.values` (Task 1's
 * local-only authoring values, keyed `` `${page}:${step}` ``) — never a
 * value read from `diff` or from anything model-bound.
 *
 * Two independent fail-closed guards, both raising `SecretMaterializationError`:
 *
 * 1. No local authoring value is available for this step: a defense-in-depth
 *    fail-closed guard. The recorder emits a secret/PII field as a `handback`
 *    step (not a fill/select), so a genuine secret never reaches this path as
 *    a fill at all; this catches any fill/select step that nonetheless lacks
 *    a captured authoring value. There is no separate schema-level
 *    "sensitive"/"redacted" flag distinct from this presence/absence signal
 *    (`RedactedValue` in schema.ts is just `{redacted:true,length}` or
 *    `{redacted:false,value}`) — so this absent-value check IS the whole
 *    schema-level secrecy guard on the postdoc side, not one branch of it.
 * 2. The target step's authoring value CONFIDENTLY VARIED across the takes
 *    behind `diff` (a `"variable"`-classified column at
 *    `>= CONFIDENT_VARIABLE_THRESHOLD` confidence — the same threshold
 *    `applyDiff` uses to decide "confident enough to auto-promote") and the
 *    caller did not pass `acknowledgeVaried: true`. This is found by
 *    correlating the target step's position among `authoring.recording`'s
 *    flattened fill/select steps to the same-position value-bearing column
 *    of `diff.columns`, exactly the zip `applyDiff` performs (diff.ts:175-210)
 *    — see `applyPostdoc`'s doc comment for the precondition this relies on.
 */
function materializeConstant(
  current: Recording,
  authoring: AuthoringRecording,
  diff: DiffResult,
  ref: StepRef,
  acknowledgeVaried: boolean,
): Recording {
  const recordedStep = getRecordedStepAt(current, ref);
  const step = recordedStep.step;

  if (step.kind !== "fill" && step.kind !== "select") {
    throw new Error(
      `Only fill and select steps can be materialized as constants, but found "${step.kind}"`,
    );
  }

  const key = `${ref.page}:${ref.step}`;
  const value = authoring.values.get(key);
  if (value === undefined) {
    throw new SecretMaterializationError(
      `applyPostdoc: cannot materialize step ${key} as a constant — no local authoring value ` +
        `is available for it. This is the fail-closed guard for secret/PII fields: the recorder ` +
        `never captures a local authoring value for those, so an absent value here means either ` +
        `a secret field or a caller mistake — never something safe to guess at.`,
    );
  }

  if (!acknowledgeVaried) {
    assertNotVariedAcrossTakes(authoring.recording, diff, ref, key);
  }

  const newStep: Step = { ...step, value: { redacted: false, value } };
  return setStepAt(current, ref, { ...recordedStep, step: newStep });
}

/**
 * Throws `SecretMaterializationError` if `ref`'s authoring value CONFIDENTLY
 * VARIED across the takes behind `diff` — see `materializeConstant`'s doc
 * comment (guard 2) and `applyPostdoc`'s doc comment for the correlation
 * precondition this relies on.
 *
 * A `base`/`diff` pair that doesn't correlate at all (mismatched lengths —
 * i.e. `diff` wasn't produced from a `diffTakes` call where `base` was
 * take 0) is a caller-contract violation, exactly like `applyDiff`'s own
 * length check — this throws a plain `Error` for that case, not
 * `SecretMaterializationError`, since it isn't a secrecy finding at all.
 */
function assertNotVariedAcrossTakes(
  base: Recording,
  diff: DiffResult,
  ref: StepRef,
  key: string,
): void {
  const baseFillSteps = flattenBaseFillSteps(base);
  const valueBearingColumns = diff.columns.filter((c) => c.values[0] !== null);

  if (baseFillSteps.length !== valueBearingColumns.length) {
    throw new Error(
      `applyPostdoc: base has ${baseFillSteps.length} fill/select step(s) but diff has ` +
        `${valueBearingColumns.length} value-bearing column(s) for take 0 — authoring must be the ` +
        `first take passed to the diffTakes(...) call that produced this diff`,
    );
  }

  const position = baseFillSteps.findIndex((s) => s.ref.page === ref.page && s.ref.step === ref.step);
  // Defensive fail-closed invariant, not reachable through any public
  // `applyPostdoc` call today (`materializeConstant` already confirmed `ref`
  // addresses a fill/select step, so it must appear in `baseFillSteps`) —
  // covered by inspection, not a test (this helper is private and not
  // independently unit-testable without exporting it solely for that
  // purpose). If this DID ever trigger (e.g. a future refactor breaks the
  // invariant), the target step's cross-take variance can no longer be
  // verified at all, so refuse to materialize rather than silently allowing
  // a possibly-secret/varied value through — the whole point of floor #6 is
  // that this guard must never fail open.
  if (position === -1) {
    throw new SecretMaterializationError(
      `applyPostdoc: cannot materialize step ${key} as a constant — its target step could not be ` +
        `located in the fill/select projection used to check cross-take variance, so its safety ` +
        `cannot be verified. Refusing to materialize rather than risk silently allowing a ` +
        `varied/secret value through.`,
    );
  }

  const column = valueBearingColumns[position];
  if (column.kind === "variable" && column.confidence >= CONFIDENT_VARIABLE_THRESHOLD) {
    throw new SecretMaterializationError(
      `applyPostdoc: cannot materialize step ${key} as a constant — its authoring value VARIED ` +
        `across takes (classified "variable" at confidence ${column.confidence.toFixed(2)}, >= the ` +
        `${CONFIDENT_VARIABLE_THRESHOLD} confident-variable threshold). Pass ` +
        `acknowledgeVaried: true on this decision to materialize take 0's value anyway.`,
    );
  }
}

/**
 * Converts the target step into a `handback` step carrying `prompt`: at
 * replay time, a human takes over instead of an automated action. The
 * `resume` assertion defaults to whatever assertion the original step
 * already required in order to proceed (its `expect`/`check`, or a
 * `"visible"` check on its own target/items for step kinds that don't carry
 * an assertion) — a decision's `label` (if any) is applied afterward by
 * `applyPostdoc`'s generic `applyLabel` step, not here.
 */
function convertToHandback(current: Recording, ref: StepRef, prompt: string): Recording {
  const recordedStep = getRecordedStepAt(current, ref);
  const original = recordedStep.step;
  const resume = deriveResumeAssertion(original);

  const newStep: Step = {
    kind: "handback",
    label: original.label,
    prompt,
    resume,
  };
  return setStepAt(current, ref, { ...recordedStep, step: newStep });
}

function deriveResumeAssertion(step: Step): Assertion {
  switch (step.kind) {
    case "navigate":
    case "click":
    case "fill":
    case "extract":
    case "select":
    case "press":
      return step.expect;
    case "assert":
      return step.check;
    case "waitFor":
      return { kind: "visible", target: step.target };
    case "forEach":
      return { kind: "visible", target: step.items };
    case "handback":
      return step.resume;
  }
}

function applyLabel(current: Recording, ref: StepRef, label: string): Recording {
  const recordedStep = getRecordedStepAt(current, ref);
  const newStep: Step = { ...recordedStep.step, label };
  return setStepAt(current, ref, { ...recordedStep, step: newStep });
}

function applyChunk(current: Recording, ref: StepRef, chunk: string): Recording {
  const recordedStep = getRecordedStepAt(current, ref);
  return setStepAt(current, ref, { ...recordedStep, chunk });
}
