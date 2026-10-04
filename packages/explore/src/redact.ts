import {
  type JudgmentState,
  assertNoSecretInPayload,
  REDACTION_MASK,
  redactText,
  redactContext,
  redactUrl,
} from "@jevitate/ai-core";

// The value-based redaction primitives now live in `@jevitate/ai-core` (next to
// the `assertNoSecretInPayload` choke point) so `@jevitate/ux` shares the exact
// same implementation — "no divergent redaction path". Re-exported here so every
// existing `@jevitate/explore` import keeps working unchanged.
export { REDACTION_MASK, redactText, redactContext, redactUrl };

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
  /** The page's visible text (untrusted, already bounded) — shown only when given (#207). */
  readonly visibleText?: string;
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
    // URLs (and any URL quoted in history) also go through the shared URL
    // rule: sensitive query/fragment parameter values are blanked.
    url: redactText(redactUrl(input.url), secrets),
    controls: input.controls.map((c) => redactText(c, secrets)),
    history: input.history.map((h) => redactText(redactUrl(h), secrets)),
    ...(input.visibleText === undefined || input.visibleText === "" ? {} : { visibleText: redactText(input.visibleText, secrets) }),
  };
  assertNoSecretInPayload(state, secrets);
  return state;
}

/**
 * #219 — THE page-content redaction step. Everything the engine reads off a page (a control's
 * accessible name, its model-facing summary, its current value, its scope label, a link's
 * destination; the page's visible text) is scrubbed of every registered secret HERE, at perception
 * time — before any mission, decision state, find-out answer (#207 `visibleText` and control-value
 * grounding), UX evidence, hang/crash report, transcript or Recording is built from it. A page that
 * merely DISPLAYS a registered secret (a profile page showing the signed-in email) is therefore never
 * a leak and never a crash: every downstream consumer only ever sees `REDACTION_MASK`, and the
 * fail-closed `assertNoSecretInPayload` guards at each sink stay as the last line.
 *
 * Fields that identify the element for ACTING (the descriptor, a `<select>`'s option labels) are
 * left as they are: they are what the page needs matched, and every sink that writes them (the
 * Recording, the transcript, the option-choice prompt) redacts them itself.
 */
export function redactPageText(text: string, secrets: readonly string[]): string {
  return secrets.length === 0 ? text : redactText(text, secrets);
}

/** A perceived control with its page content scrubbed (see `redactPageText`). */
export function redactControl<
  C extends {
    readonly name: string;
    readonly summary: string;
    readonly value?: string | null;
    readonly scope?: string | null;
    readonly heading?: string | null;
    readonly href?: string | null;
  },
>(c: C, secrets: readonly string[]): C {
  if (secrets.length === 0) return c;
  const r = (s: string): string => redactText(s, secrets);
  return {
    ...c,
    name: r(c.name),
    summary: r(c.summary),
    ...(c.value === undefined || c.value === null ? {} : { value: r(c.value) }),
    ...(c.scope === undefined || c.scope === null ? {} : { scope: r(c.scope) }),
    ...(c.heading === undefined || c.heading === null ? {} : { heading: r(c.heading) }),
    ...(c.href === undefined || c.href === null ? {} : { href: r(c.href) }),
  };
}
