import type { ReplayTargetFailure, ResolvedTarget } from "./resolve-target.js";
import type { Assertion } from "@jevitate/recording";
import type { StepWait } from "./outcome-wait.js";

/**
 * The result of running a whole (or partial, for `runToCheckpoint`)
 * `Recording` via `RecordingInterpreter`.
 *
 * - `"completed"` means every step it was asked to run (the whole recording
 *   for `run`, or up to and including the requested checkpoint for
 *   `runToCheckpoint`) resolved `{kind:"done"}`. It carries the final
 *   variable bindings as a plain `Record` (converted from the internal
 *   `Map<string,string>` threaded through every step).
 * - `"awaiting_human"` mirrors a `handback` step's `StepOutcome`, but `at` is
 *   the step's GLOBAL flat index across the whole recording (see
 *   `RecordingInterpreter`'s doc comment), not a per-page index.
 * - `"failed"` means `runStep` threw at global index `at`; `error` is that
 *   error's message. This applies to ANY thrown error, not only a
 *   `PostconditionFailed` — `RecordingInterpreter`'s `runFlat` catches every
 *   error kind so a failure is always pinned to the step that caused it.
 *   Pre-flight errors (schema validation, `forEach` child-kind checks, an
 *   invalid `runToCheckpoint` argument) happen before any step runs and
 *   still propagate as rejected promises instead, since there is no step
 *   index to report.
 */
export type InterpretResult = (
  | { outcome: "completed"; vars: Record<string, string> }
  | { outcome: "awaiting_human"; at: number; prompt: string; resume: Assertion }
  | {
      outcome: "failed";
      at: number;
      error: string;
      /**
       * Why, when it is a replay-TARGET problem: the recorded element is missing
       * (`replay-target-not-found`) or cannot be told apart from others (`ambiguous`). Absent for
       * every other failure (a postcondition, an automation error).
       */
      reason?: ReplayTargetFailure;
    }
) & {
  /**
   * #409: the outcome wait of every step that declared `waitFor` and ran its postcondition, in run
   * order (a failed waited step included). Absent when no step waited.
   */
  waits?: StepWait[];
  /**
   * #470: how each step's target resolved (the rung, and any ordinal it needed), in run order — the
   * dynamic half of locator health. Absent when no step resolved a target.
   */
  resolved?: StepResolution[];
};

/** #470: one step's resolved target — its flat index, its stable id when it has one, and how. */
export type StepResolution = ResolvedTarget & { readonly index: number; readonly stepId?: string };
