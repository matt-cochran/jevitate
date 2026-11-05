import type { Locator } from "playwright";
import type { RecordedStep } from "@jevitate/recording";

/**
 * #789: a refusal that ends the whole replay. It is not a failed step: it is never healed, retried or
 * mapped to a replay outcome, and it passes through the interpreter and the runner to the caller.
 */
export class ReplayRefusal extends Error {
  override readonly name: string = "ReplayRefusal";
}

/**
 * #789: an optional check around a replay's actions. Unlike a `StepObserver` (which never changes a
 * replay), a guard ends it by throwing a `ReplayRefusal`. Absent by default, so behavior is unchanged.
 */
export interface ReplayActionGuard {
  /**
   * Awaited once the target is resolved, right before a click or a key press acts on it (`key` set: the
   * focused element; a key can act past it, as Enter in a field clicks its form's default button, so the
   * guard judges what the key reaches). Throwing a `ReplayRefusal` keeps the action from running.
   */
  beforeAction(ctx: { readonly index: number; readonly recorded: RecordedStep; readonly locator: Locator; readonly key?: string }): Promise<void>;
  /** After every step, and after a failed one (a refused write can be why it failed): throws what ended the run. */
  afterStep(ctx: { readonly index: number }): void;
}
