import type { Assertion } from "@doit/recording";

/**
 * The result of running one step via `runStep`.
 *
 * `"done"` means the step's action (if any) succeeded and its postcondition
 * held. `"awaiting_human"` is produced only by a `handback` step: it signals
 * that replay must pause for a human to act, and carries the `prompt` to
 * show them, the `resume` assertion a future caller must itself re-check
 * before continuing (runStep does NOT check it), and the step's `index`
 * within the recording (see `runStep`'s doc comment for why that's a
 * parameter rather than something `runStep` computes).
 */
export type StepOutcome =
  | { kind: "done" }
  | { kind: "awaiting_human"; prompt: string; resume: Assertion; index: number };
