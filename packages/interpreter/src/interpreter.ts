import type { Recording, RecordedStep, Step } from "@doit/recording";
import { RecordingSchema } from "@doit/recording";
import type { Actor } from "@doit/screenplay";
import { PostconditionFailed } from "./assertion.js";
import type { InterpretResult } from "./interpret-result.js";
import { runStep } from "./run-step.js";

/**
 * The `forEach` child step kinds Task 4's `run-step.ts` actually supports
 * row-scoped (see `runRowScopedChildStep`). Kept in sync with that switch's
 * cases by hand — there are only two, and duplicating the list here (rather
 * than importing runtime internals from run-step.ts) keeps this a pure,
 * side-effect-free pre-flight check.
 */
const SUPPORTED_FOREACH_CHILD_KINDS = new Set(["click", "extract"]);

/**
 * Sequences a whole `Recording` through `runStep`, threading one shared
 * `vars` `Map` across every step so `extract`/`forEach` writes and any
 * `{var}` reads in later steps see each other.
 *
 * `Recording`'s steps are nested `pages[].steps[]`; both `run` and
 * `runToCheckpoint` flatten them into ONE ordered sequence
 * (`rec.pages.flatMap(p => p.steps)`) and index into THAT — a step's
 * "global index" is its 0-based position in this flattened array (page 0's
 * steps first, then page 1's, etc.), never a per-page index. This is what
 * `InterpretResult`'s `at` field and `runToCheckpoint`'s `stepIndex`
 * parameter both refer to.
 */
export class RecordingInterpreter {
  /**
   * Runs the entire recording from the start, stopping early at the first
   * `awaiting_human` (a `handback` step) or the first `PostconditionFailed`.
   *
   * `vars` seeds the initial variable bindings (default `{}`); it is copied
   * into an internal `Map<string,string>` and never mutates the caller's
   * object.
   */
  async run(actor: Actor, rec: Recording, vars?: Record<string, string>): Promise<InterpretResult> {
    validateRecording(rec);
    const flat = flatten(rec);
    const varsMap = new Map(Object.entries(vars ?? {}));
    return runFlat(actor, flat, varsMap, flat.length - 1);
  }

  /**
   * Replays the recording up to and including the step at global index
   * `stepIndex`, then stops — the basis for replay-to-point. Behaves exactly
   * like `run` (same early-stop rules) except it only iterates through
   * `stepIndex`.
   *
   * A `stepIndex` at or past the recording's end (`>= flat.length - 1`) runs
   * the whole recording, equivalent to `run` — a reasonable caller mistake,
   * not an error. A negative `stepIndex` throws, since there is no sane
   * partial-replay interpretation of it.
   *
   * NOTE (deferred to a future milestone, documentation-only): unlike `run`,
   * this has no `vars`-seed parameter — it always starts from an empty
   * `vars` map. True "replay from a checkpoint with previously-accumulated
   * variables" (e.g. splicing a fresh tail onto a partially-replayed
   * recording) isn't supported yet; a future replay-to-point/splice workflow
   * will need to add one, mirroring `run`'s `vars` parameter.
   */
  async runToCheckpoint(actor: Actor, rec: Recording, stepIndex: number): Promise<InterpretResult> {
    if (stepIndex < 0) {
      throw new Error(`runToCheckpoint: stepIndex must be >= 0, got ${stepIndex}`);
    }
    validateRecording(rec);
    const flat = flatten(rec);
    const varsMap = new Map<string, string>();
    const lastIndex = Math.min(stepIndex, flat.length - 1);
    return runFlat(actor, flat, varsMap, lastIndex);
  }
}

function flatten(rec: Recording): RecordedStep[] {
  return rec.pages.flatMap((p) => p.steps);
}

/**
 * The interpreter's trust boundary (RxD design spec): validates `rec`
 * against `RecordingSchema` and pre-flight-checks every `forEach`'s child
 * step kinds, BEFORE any step of the recording executes.
 *
 * Without this, a schema-valid `Recording` whose `forEach.steps[]` contains
 * an unsupported child kind (e.g. `navigate`, which A.1 only supports as a
 * top-level step) would let row 0's OTHER children run — real actions like a
 * `click` — before `run-step.ts`'s per-child-kind switch throws on a later
 * row/kind. That's a partially-applied loop, which violates fail-closed in
 * spirit even though each individual step is itself fail-closed.
 *
 * `RecordingSchema.parse` is idempotent on already-valid data, so re-parsing
 * a caller-supplied, already-parsed `Recording` is still correct and cheap.
 */
function validateRecording(rec: Recording): void {
  RecordingSchema.parse(rec);
  rec.pages.forEach((page, pageIndex) => {
    page.steps.forEach((recordedStep, stepIndexInPage) => {
      checkForEachChildKinds(recordedStep.step, pageIndex, stepIndexInPage);
    });
  });
}

/**
 * `forEach` is not nested in A.1 (a `forEach`'s own `steps[]` cannot contain
 * another `forEach`), so this is one level of recursion into `forEach.steps[]`
 * — not a general recursive walk over arbitrarily nested steps.
 */
function checkForEachChildKinds(step: Step, pageIndex: number, stepIndexInPage: number): void {
  if (step.kind !== "forEach") return;
  for (const childStep of step.steps) {
    if (!SUPPORTED_FOREACH_CHILD_KINDS.has(childStep.kind)) {
      throw new Error(
        `forEach at page ${pageIndex} step ${stepIndexInPage} has an unsupported child kind: ${childStep.kind}`,
      );
    }
  }
}

/**
 * Shared driver for `run`/`runToCheckpoint`: executes `flat[0..lastIndex]`
 * (inclusive) in order against the shared `vars` map, stopping early on
 * `awaiting_human` or a caught `PostconditionFailed`. Any other thrown error
 * is deliberately NOT caught here — it propagates to the caller, since it
 * signals a bug or misconfiguration rather than an expected postcondition
 * failure (the plan's own language is "stops at ... the first
 * `PostconditionFailed`," not "any error").
 */
async function runFlat(
  actor: Actor,
  flat: RecordedStep[],
  vars: Map<string, string>,
  lastIndex: number,
): Promise<InterpretResult> {
  for (let i = 0; i <= lastIndex; i++) {
    let outcome;
    try {
      outcome = await runStep(actor, flat[i], vars, i);
    } catch (err) {
      // NOTE (deferred to a future milestone, documentation-only):
      // `InterpretResult.failed.at` (this `i`) is ONLY populated when the
      // thrown error is `PostconditionFailed`. Any OTHER propagating error
      // (a stale selector, a Playwright strict-mode multi-match, an action
      // timeout, etc.) rejects `run`/`runToCheckpoint` with NO step index at
      // all — the `throw err` below loses `i` entirely. This will matter
      // once a future milestone's diff/localization tooling wants to pin
      // every failure to a step, regardless of error kind.
      if (err instanceof PostconditionFailed) {
        return { outcome: "failed", at: i, error: err.message };
      }
      throw err;
    }
    if (outcome.kind === "awaiting_human") {
      return { outcome: "awaiting_human", at: i, prompt: outcome.prompt, resume: outcome.resume };
    }
  }
  return { outcome: "completed", vars: Object.fromEntries(vars) };
}
