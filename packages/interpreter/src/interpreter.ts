import type { Assertion, Recording, RecordedStep, Step, StepTiming } from "@jevitate/recording";
import { RecordingSchema } from "@jevitate/recording";
import { BrowseTheWebToken, type Actor } from "@jevitate/screenplay";
import { installFlashRecorder } from "./flash-recorder.js";
import type { InterpretResult } from "./interpret-result.js";
import type { StepWait } from "./outcome-wait.js";
import { runStep } from "./run-step.js";
import { ReplayTargetError, type ResolveTargetOptions } from "./resolve-target.js";
import type { RecordingSink } from "./sink.js";
import { clock } from "@jevitate/domain";

/**
 * The `forEach` child step kinds Task 4's `run-step.ts` actually supports
 * row-scoped (see `runRowScopedChildStep`). Kept in sync with that switch's
 * cases by hand — there are only two, and duplicating the list here (rather
 * than importing runtime internals from run-step.ts) keeps this a pure,
 * side-effect-free pre-flight check.
 */
/**
 * #246: an optional per-step observer — called around each top-level step the interpreter runs
 * (`beforeStep` just before it acts, `afterStep` once it finished, whatever the outcome). It sees the
 * actor (to read the page) and the step, and can never change the replay: its errors are swallowed,
 * and the step, its values and the vars are exactly what they would be without it. Used by
 * `journey annotate` to capture before/after page evidence; absent by default (zero behavior change).
 */
export interface StepObserver {
  beforeStep?(ctx: { readonly actor: Actor; readonly index: number; readonly recorded: RecordedStep }): Promise<void>;
  afterStep?(ctx: {
    readonly actor: Actor;
    readonly index: number;
    readonly recorded: RecordedStep;
    readonly outcome: "done" | "awaiting_human" | "failed";
  }): Promise<void>;
}

async function observe(fn: (() => Promise<void>) | undefined): Promise<void> {
  if (fn === undefined) return;
  try {
    await fn();
  } catch {
    // An observer never changes the replay (see StepObserver).
  }
}

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
   * `targetTimeoutMs`: how long a recorded target may take to appear before the step fails as
   * `replay-target-not-found` / `ambiguous` (default 15s).
   */
  constructor(
    private readonly options: {
      readonly targetTimeoutMs?: number;
      readonly observer?: StepObserver;
      /**
       * #402: a mutation proof replays a Journey with one step's action left out. `skipStep`
       * decides, by flat step index, whether this replay SKIPS that step's action and postcondition.
       * Indices are never renumbered (`at`, anchors and `expectRequests` keep pointing at the same
       * steps); a skipped step still gets observer `beforeStep`/`afterStep` (outcome `done`) and is
       * never sunk. Absent by default, so behavior is unchanged.
       */
      readonly skipStep?: (index: number, recorded: RecordedStep) => boolean;
    } = {},
  ) {}

  #targetOpts(): ResolveTargetOptions & {
    observer?: StepObserver;
    skipStep?: (index: number, recorded: RecordedStep) => boolean;
  } {
    return {
      ...(this.options.targetTimeoutMs === undefined ? {} : { timeoutMs: this.options.targetTimeoutMs }),
      ...(this.options.observer === undefined ? {} : { observer: this.options.observer }),
      ...(this.options.skipStep === undefined ? {} : { skipStep: this.options.skipStep }),
    };
  }

  /**
   * Runs the entire recording from the start, stopping early at the first
   * `awaiting_human` (a `handback` step) or the first step that throws
   * (a `PostconditionFailed` or any other error).
   *
   * `vars` seeds the initial variable bindings (default `{}`); it is copied
   * into an internal `Map<string,string>` and never mutates the caller's
   * object.
   *
   * `sink`, when given, receives one `RecordedStep` per top-level step that
   * completes successfully (`{kind:"done"}`), in order, with genuinely
   * measured timing (see `runFlat`'s doc comment) — "always-on recording"
   * (design spec §5b): an automated run can emit a `Recording` describing
   * what it actually did, directly comparable to a human-authored/captured
   * one. `sink` is entirely optional and off by default: omitting it is
   * zero behavior change from before this parameter existed.
   */
  async run(
    actor: Actor,
    rec: Recording,
    vars?: Record<string, string>,
    sink?: RecordingSink,
  ): Promise<InterpretResult> {
    validateRecording(rec);
    const flat = flatten(rec);
    const varsMap = new Map(Object.entries(vars ?? {}));
    return runFlat(actor, flat, varsMap, flat.length - 1, this.#targetOpts(), sink);
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
    return runFlat(actor, flat, varsMap, lastIndex, this.#targetOpts());
  }

  /**
   * Continues a recording from global index `fromIndex` through the end —
   * the basis for post-handback resume: once a human has acted on a
   * `handback` (secret) step and its postcondition has been separately
   * verified, the `JourneyRunner` calls this to run the REMAINING steps
   * without re-running anything before `fromIndex`.
   *
   * Mirrors `run`'s pre-flight (`validateRecording`) and `vars`/`sink`
   * handling exactly; the only difference is where the shared loop starts.
   */
  async resumeFrom(
    actor: Actor,
    rec: Recording,
    fromIndex: number,
    vars: Record<string, string> = {},
    sink?: RecordingSink,
  ): Promise<InterpretResult> {
    validateRecording(rec);
    const flat = flatten(rec);
    return runFlat(actor, flat, new Map(Object.entries(vars)), flat.length - 1, this.#targetOpts(), sink, fromIndex);
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
    // #409: an outcome wait is a top-level step's; a row-scoped child never waits.
    if ("waitFor" in childStep && childStep.waitFor !== undefined) {
      throw new Error(`forEach at page ${pageIndex} step ${stepIndexInPage} has a child step with waitFor (an outcome wait belongs on a top-level step)`);
    }
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
 * `awaiting_human` or a failed step. ANY error thrown by `runStep` — a
 * `PostconditionFailed`, a stale selector, a Playwright strict-mode
 * multi-match, a timeout, or any other bug/misconfiguration — is caught
 * right here and converted into `{outcome:"failed", at:i, error}`, `i`
 * being this step's correct global flat index. This is deliberately NOT
 * narrowed to `PostconditionFailed`: `InterpretResult.failed.at` must be
 * accurate for every error kind, not only an expected postcondition
 * failure, so a caller (e.g. future diff/localization tooling) can always
 * pin a failure to a step.
 *
 * Pre-flight errors (schema validation, `forEach` child-kind checks in
 * `validateRecording`, or a negative `runToCheckpoint` `stepIndex`) happen
 * BEFORE this loop starts and are intentionally NOT caught here — they
 * still propagate as rejected promises, since no step (and therefore no
 * step index) has run yet.
 *
 * `sink` (optional; `undefined` for `runToCheckpoint`, which does not
 * support sinking) is fed one `RecordedStep` per iteration of this loop that
 * completes with `{kind:"done"}` — the SAME granularity as this loop's own
 * top-level steps, so a `forEach` is sunk once as a whole, never expanded
 * per row (its row-scoped children have no `RecordedStep` wrapper of their
 * own to sink). A step that throws (postcondition failure or otherwise) is
 * never sunk — the run stops there, and a sink recording shorter than the
 * input is the correct, expected signal for a failed run. `awaiting_human`
 * likewise stops the loop before that step is sunk.
 *
 * Timing is measured with `performance.now()` around each `runStep` call,
 * NOT copied from the input step's own (possibly absent) `timing` — this is
 * what makes the emitted `Recording` describe what THIS run actually did:
 * `atMs` is time since this run started, `durationMs` is this step's own
 * wall-clock duration, and `gapBeforeMs` is the wall-clock gap since the
 * previous SUNK step finished (0 for the first sunk step, since it's
 * measured from the same instant the run started).
 *
 * Crucially, the sunk `RecordedStep`'s `step` data (target/value/etc.) is
 * the INPUT step's data, unchanged — only `timing` is replaced. This
 * preserves whatever redaction the input already encoded (`{redacted:true,
 * length}` or `{var:"..."}` stays exactly that); the actual runtime string
 * `resolveValue` computed for typing/selecting is never substituted in.
 */
async function runFlat(
  actor: Actor,
  flat: RecordedStep[],
  vars: Map<string, string>,
  lastIndex: number,
  runOpts: ResolveTargetOptions & {
    observer?: StepObserver;
    skipStep?: (index: number, recorded: RecordedStep) => boolean;
  },
  sink?: RecordingSink,
  startIndex = 0,
): Promise<InterpretResult> {
  const { observer, skipStep, ...targetOpts } = runOpts;
  // A transient-state check (#148) needs the flash recorder BEFORE the action that triggers it.
  if (flat.slice(startIndex, lastIndex + 1).some((r) => stepAssertions(r.step).some((a) => a.kind === "flashed"))) {
    await installFlashRecorder(actor.ability(BrowseTheWebToken).session.page);
  }
  // #409: each waited step's outcome wait, reported on the result (only when a step waited).
  const waits: StepWait[] = [];
  const stepOpts = { ...targetOpts, onWait: (w: StepWait) => void waits.push(w) };
  const withWaits = <R extends InterpretResult>(r: R): R => (waits.length === 0 ? r : { ...r, waits });
  const runStartedAt = clock.monotonicMs();
  let lastSunkStepEndedAt = runStartedAt;
  for (let i = startIndex; i <= lastIndex; i++) {
    let outcome;
    const recorded = flat[i] as RecordedStep;
    await observe(observer?.beforeStep && (() => observer.beforeStep!({ actor, index: i, recorded })));
    // #402: a skipped step never runs its action or expect, and records nothing to the sink; the
    // index is not renumbered, so later steps keep their flat positions.
    if (skipStep?.(i, recorded) === true) {
      await observe(observer?.afterStep && (() => observer.afterStep!({ actor, index: i, recorded, outcome: "done" })));
      continue;
    }
    const stepStartedAt = clock.monotonicMs();
    try {
      outcome = await runStep(actor, flat[i], vars, i, stepOpts);
    } catch (err) {
      await observe(observer?.afterStep && (() => observer.afterStep!({ actor, index: i, recorded, outcome: "failed" })));
      const message = err instanceof Error ? err.message : String(err);
      return withWaits(
        err instanceof ReplayTargetError
          ? { outcome: "failed", at: i, error: message, reason: err.kind }
          : { outcome: "failed", at: i, error: message },
      );
    }
    const stepEndedAt = clock.monotonicMs();
    await observe(
      observer?.afterStep &&
        (() => observer.afterStep!({ actor, index: i, recorded, outcome: outcome.kind === "awaiting_human" ? "awaiting_human" : "done" })),
    );
    if (outcome.kind === "awaiting_human") {
      return withWaits({ outcome: "awaiting_human", at: i, prompt: outcome.prompt, resume: outcome.resume });
    }
    if (sink) {
      const timing: StepTiming = {
        atMs: stepStartedAt - runStartedAt,
        durationMs: stepEndedAt - stepStartedAt,
        gapBeforeMs: stepStartedAt - lastSunkStepEndedAt,
      };
      sink.step({ ...flat[i], timing });
      lastSunkStepEndedAt = stepEndedAt;
    }
  }
  return withWaits({ outcome: "completed", vars: Object.fromEntries(vars) });
}

/** Every assertion a step carries (its postcondition / check / resume). */
function stepAssertions(step: Step): Assertion[] {
  if (step.kind === "assert") return [step.check];
  if (step.kind === "handback") return [step.resume];
  return "expect" in step ? [step.expect] : [];
}
