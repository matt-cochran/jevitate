import type { Assertion } from "@jevitate/recording";

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
export type InterpretResult =
  | { outcome: "completed"; vars: Record<string, string> }
  | { outcome: "awaiting_human"; at: number; prompt: string; resume: Assertion }
  | { outcome: "failed"; at: number; error: string };
