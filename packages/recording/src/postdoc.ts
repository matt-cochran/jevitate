import type { Recording, RecordedStep, PageSegment, Step, Assertion } from "./schema.js";
import { RecordingSchema } from "./schema.js";
import type { AuthoringRecording } from "./diff.js";
import type { DiffResult } from "./classify.js";
import { promoteToVariable } from "./promote.js";
import type { StepRef } from "./promote.js";

/**
 * One human decision made during postdoc review about a single fill/select
 * (or, for `"handback"`, any) step: how to classify its captured value, plus
 * optional cosmetic annotations.
 *
 * - `"constant"` — materialize the LOCAL authoring value (never a value sent
 *   to a model) as a literal, but ONLY when non-secret (Task 5: "non-secret"
 *   means an authoring value is actually available for this step; the full
 *   named-field/sensitivity guard is Task 6's `SecretMaterializationError`).
 * - `"variable"` — promote the step's value to a `{var: name}` slot via
 *   A.3a's `promoteToVariable`.
 * - `"handback"` — convert the step into a `handback` step: the human takes
 *   over at replay time instead of an automated action.
 *
 * `label`/`chunk` are applied regardless of `classify` — `label` sets the
 * resulting step's own `label` field; `chunk` tags the `RecordedStep` with a
 * human-assigned higher-level "chunk" (Screenplay Task/Action) name for
 * later grouping (see `RecordedStep.chunk` in `schema.ts`).
 */
export type PostdocDecision = { step: StepRef } & (
  | { classify: "constant" }
  | { classify: "variable"; name: string }
  | { classify: "handback"; prompt: string }
) & { label?: string; chunk?: string };

/**
 * Turns one authoring take + the A.3a diff + a list of explicit human
 * decisions into a parameterized `Recording`.
 *
 * Only steps named by a decision are touched. A fill/select step with NO
 * decision is left completely untouched — still whatever `authoring`
 * captured it as (in practice, real recorder output redacts it:
 * `{redacted:true,length}`). This is deliberate and fail-closed: nothing is
 * ever materialized (as a constant OR promoted to a variable) without an
 * explicit decision — `diff` is accepted for API symmetry with
 * `diffTakes`/future extension (Task 6's varying-value guard, the postdoc
 * TUI's suggestions) but this function does not need to consult it to
 * satisfy that contract, since "untouched" is already the fail-closed
 * default regardless of what the diff would have suggested.
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
 * @throws if a `constant` decision targets a step with no local authoring
 *   value (the fail-closed stand-in for "secret" in this task — Task 6
 *   formalizes this into `SecretMaterializationError`), or a non-fill/select
 *   step, or if any `step` ref is out of range.
 */
export function applyPostdoc(
  authoring: AuthoringRecording,
  _diff: DiffResult,
  decisions: PostdocDecision[],
): Recording {
  let current = authoring.recording;

  for (const decision of decisions) {
    const ref = decision.step;

    if (decision.classify === "variable") {
      current = promoteToVariable(current, ref, decision.name);
    } else if (decision.classify === "constant") {
      current = materializeConstant(current, authoring, ref);
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
 * Fails closed when no local authoring value is available for this step:
 * that is exactly the case for a secret/PII field (the recorder never
 * captures an authoring value for those) as well as any other step the
 * caller mistakenly targets. Task 6 replaces this simple `Error` with a
 * named `SecretMaterializationError` and adds the "value varies across
 * takes" guard; this task's job is only to make the happy path correct and
 * this path fail-closed.
 */
function materializeConstant(
  current: Recording,
  authoring: AuthoringRecording,
  ref: StepRef,
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
    throw new Error(
      `applyPostdoc: cannot materialize step ${key} as a constant — no local authoring value ` +
        `is available for it (this is the fail-closed default for secret/absent-value fields; ` +
        `see the full SecretMaterializationError guard added in Task 6)`,
    );
  }

  const newStep: Step = { ...step, value: { redacted: false, value } };
  return setStepAt(current, ref, { ...recordedStep, step: newStep });
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
