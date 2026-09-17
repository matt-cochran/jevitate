import type { Recording, RecordedStep } from "@doit/recording";
import type { Actor } from "@doit/screenplay";
import { PostconditionFailed } from "./assertion.js";
import type { InterpretResult } from "./interpret-result.js";
import { runStep } from "./run-step.js";

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
   */
  async runToCheckpoint(actor: Actor, rec: Recording, stepIndex: number): Promise<InterpretResult> {
    if (stepIndex < 0) {
      throw new Error(`runToCheckpoint: stepIndex must be >= 0, got ${stepIndex}`);
    }
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
