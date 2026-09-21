import {
  type JudgmentState,
  assertNoSecretInPayload,
  REDACTION_MASK,
  redactText,
  redactContext,
} from "@jevitate/ai-core";

// The value-based redaction primitives now live in `@jevitate/ai-core` (next to
// the `assertNoSecretInPayload` choke point) so `@jevitate/ux` shares the exact
// same implementation — "no divergent redaction path". Re-exported here so every
// existing `@jevitate/explore` import keeps working unchanged.
export { REDACTION_MASK, redactText, redactContext };

/**
 * State redaction before ANY model call (guardrail #3: no secrets to models).
 *
 * The exploration loop builds a model-facing `JudgmentState` (for Jev) and a
 * `visibleContext` string (for the generation gateway) out of the perceived
 * page. Both are scrubbed of every registered secret/PII value here FIRST,
 * and then — belt and suspenders — routed through ai-core's shared
 * `assertNoSecretInPayload` choke point, which throws if any secret somehow
 * survived. Redact, then prove the redaction worked: a leak is a hard
 * failure, never a silently-sent value.
 *
 * Note this is the *value* defense. The snapshot layer additionally never
 * reads a password/OTP field's value into a control summary at all (mirroring
 * `@jevitate/recorder`'s in-page fact reader), so a secret field's contents
 * never reach this function to begin with; registered secrets that leak in
 * through some other field's value are caught here.
 */

export interface BuildStateInput {
  readonly goal: string;
  readonly url: string;
  /** Already-summarized control labels (role/name/state), NOT raw values. */
  readonly controls: readonly string[];
  readonly history: readonly string[];
  /** Registered secret/PII values to scrub. Default none. */
  readonly secrets?: readonly string[];
}

/**
 * Builds the redacted `JudgmentState` Jev sees. Throws (via
 * `assertNoSecretInPayload`) if any registered secret survives — it never
 * returns a state that still contains one.
 */
export function buildJudgmentState(input: BuildStateInput): JudgmentState {
  const secrets = input.secrets ?? [];
  const state: JudgmentState = {
    goal: redactText(input.goal, secrets),
    url: redactText(input.url, secrets),
    controls: input.controls.map((c) => redactText(c, secrets)),
    history: input.history.map((h) => redactText(h, secrets)),
  };
  assertNoSecretInPayload(state, secrets);
  return state;
}
