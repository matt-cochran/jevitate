// redact.ts — the ONLY door evidence passes through before a model call.
//
// `RedactedEvidence` is a BRANDED type (Global Constraint #4 / task invariant #2):
// every model-call function (the Jev judge AND the generative recommend) accepts
// ONLY `RedactedEvidence`, so raw `UxEvidence` physically cannot reach a model —
// a compile-time gate. `redactEvidence` reuses ai-core's shared `redactContext`
// (which internally proves the scrub via `assertNoSecretInPayload`) and FAILS
// CLOSED: if the redactor cannot run, or leaves any registered secret behind, it
// THROWS and never returns a raw/partial value.
import { assertNoSecretInPayload, redactContext, redactUrl } from "@jevitate/ai-core";
import type { A11yFacts, AppContext, BehaviorSignals, ScreenRef, UxEvidence } from "./types.js";

declare const REDACTED_BRAND: unique symbol;

/** A redacted, model-safe control summary (raw values already scrubbed). */
export interface RedactedControl {
  readonly index: number;
  readonly role: string;
  readonly name: string;
  readonly summary: string;
  readonly enabled: boolean;
  readonly inputType: string | null;
}

/**
 * Evidence that has passed the redaction door. The brand makes it unconstructable
 * outside `redactEvidence`, so a model-call signature typed to `RedactedEvidence`
 * can never be handed raw `UxEvidence`.
 */
export interface RedactedEvidence {
  readonly [REDACTED_BRAND]: "RedactedEvidence";
  readonly screenId: string;
  readonly url: string;
  readonly controls: readonly RedactedControl[];
  readonly visibleText: string;
  readonly appContext: AppContext;
  readonly job?: string;
  readonly history: readonly ScreenRef[];
  readonly behavior: BehaviorSignals;
  readonly a11yFacts: A11yFacts;
  /** Ref tokens that resolve into this evidence (for the finding gate). */
  readonly refs: ReadonlySet<string>;
}

export class RedactionUnavailableError extends Error {
  readonly code = "E_UX_REDACTION_UNAVAILABLE" as const;
  constructor(cause: unknown) {
    super(
      `evidence redaction could not run — failing closed, raw evidence never sent to a model (${cause instanceof Error ? cause.message : String(cause)})`,
    );
    this.name = "RedactionUnavailableError";
  }
}

/** A redactor scrubs one string of the given secrets. Default: ai-core's proven `redactContext`. */
export type Redactor = (text: string, secrets: readonly string[]) => string;

/** The stable ref tokens that resolve into a screen's evidence. */
export function deriveRefs(evidence: UxEvidence): Set<string> {
  const refs = new Set<string>();
  refs.add("url");
  refs.add("behavior");
  for (const c of evidence.controls) refs.add(`control:${c.index}`);
  if (evidence.visibleText.trim().length > 0) refs.add("visibleText");
  if (evidence.history.length > 0) refs.add("history");
  if (evidence.a11yFacts.controls.length > 0) refs.add("a11y");
  return refs;
}

/**
 * Redacts every model-facing string of a screen's evidence and returns branded
 * `RedactedEvidence`. Fail-closed: any thrown redactor → `RedactionUnavailableError`;
 * any surviving secret → the proof step throws. Never returns raw on error.
 */
export function redactEvidence(
  evidence: UxEvidence,
  secrets: readonly string[],
  redactor: Redactor = redactContext,
): RedactedEvidence {
  let scrub: Redactor;
  try {
    // Probe the redactor once so an unavailable backend fails here, not mid-object.
    redactor("", secrets);
    scrub = redactor;
  } catch (cause) {
    throw new RedactionUnavailableError(cause);
  }

  let redacted: Omit<RedactedEvidence, typeof REDACTED_BRAND>;
  try {
    redacted = {
      screenId: evidence.screenId,
      url: scrub(redactUrl(evidence.url), secrets),
      controls: evidence.controls.map((c) => ({
        index: c.index,
        role: c.role,
        name: scrub(c.name, secrets),
        summary: scrub(c.summary, secrets),
        enabled: c.enabled,
        inputType: c.inputType,
      })),
      visibleText: scrub(evidence.visibleText, secrets),
      appContext: evidence.appContext,
      ...(evidence.job !== undefined ? { job: scrub(evidence.job, secrets) } : {}),
      history: evidence.history.map((h) => ({ ...h, url: scrub(redactUrl(h.url), secrets) })),
      behavior: evidence.behavior,
      a11yFacts: evidence.a11yFacts,
      refs: deriveRefs(evidence),
    };
  } catch (cause) {
    // A redactor that throws mid-object (e.g. the proof step inside redactContext)
    // must still fail closed — never fall through to a raw return.
    throw new RedactionUnavailableError(cause);
  }

  // Belt-and-suspenders: prove the whole assembled object is secret-free.
  assertNoSecretInPayload(redacted, secrets);

  return Object.freeze(redacted) as RedactedEvidence;
}
