import type { GenerationPort } from "@jevitate/ai-core";
import { redactContext, redactUrl } from "./redact.js";

/**
 * fill: the generative-text helper discipline for a `type` op (guardrail #3).
 *
 * On `type`, the loop asks the generation gateway for a value for the chosen
 * field. Three disciplines are enforced here:
 *
 *  1. **Redact first.** Every string handed to the model (field label, goal,
 *     visible context, history) is scrubbed of registered secrets and proven
 *     clean (`redactContext`), and the context is bounded to the gateway's
 *     4000-char ceiling.
 *  2. **Reuse only while the input is identical.** A value is regenerated only
 *     when the helper input changes; re-asking for the same field/goal/context
 *     returns the cached value rather than paying for a second round-trip and
 *     risking a different answer mid-retry.
 *  3. **Discard after a successful mutation.** Once the value has been typed
 *     and the step succeeded, the caller calls `commit()` and the cache is
 *     dropped — a value is never silently carried into a different field.
 *
 * The gateway itself only ever returns text (never a real recipient), and may
 * return `{ text: null }` for a required value it cannot honestly supply; the
 * helper passes that through (the loop then blocks rather than typing a guess).
 */

export interface FillRequest {
  readonly fieldLabel: string;
  readonly goal: string;
  readonly visibleContext: string;
  readonly history?: readonly string[];
  readonly secrets?: readonly string[];
}

export interface FillResult {
  readonly text: string | null;
}

/** The generation gateway's documented input ceiling for `visibleContext`. */
const CONTEXT_CEILING = 4000;

export class FillHelper {
  #cacheKey: string | null = null;
  #cacheValue: string | null = null;
  #calls = 0;

  constructor(private readonly gen: GenerationPort) {}

  /** How many times the underlying gateway was actually called (for tests). */
  get generateCalls(): number {
    return this.#calls;
  }

  async valueFor(req: FillRequest): Promise<FillResult> {
    const secrets = req.secrets ?? [];
    const input = {
      fieldLabel: redactContext(req.fieldLabel, secrets),
      goal: redactContext(req.goal, secrets),
      visibleContext: redactContext(req.visibleContext, secrets).slice(0, CONTEXT_CEILING),
      history: (req.history ?? []).map((h) => redactContext(redactUrl(h), secrets)),
    };
    const key = JSON.stringify(input);
    if (this.#cacheKey === key) {
      return { text: this.#cacheValue };
    }
    this.#calls += 1;
    const res = await this.gen.generate("form.value", input);
    this.#cacheKey = key;
    this.#cacheValue = res.output.text;
    return { text: res.output.text };
  }

  /** Drop the reused value after a successful mutation. */
  commit(): void {
    this.#cacheKey = null;
    this.#cacheValue = null;
  }
}
