import type { Assertion } from "@doit/recording";

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
 * - `"failed"` means `runStep` threw `PostconditionFailed` at global index
 *   `at`; `error` is that error's message. Any OTHER thrown error is not
 *   converted to this shape — it propagates out of `run`/`runToCheckpoint`
 *   as a rejected promise instead, since it signals a bug or misconfiguration
 *   rather than an expected postcondition failure.
 */
export type InterpretResult =
  | { outcome: "completed"; vars: Record<string, string> }
  | { outcome: "awaiting_human"; at: number; prompt: string; resume: Assertion }
  | { outcome: "failed"; at: number; error: string };
