import type { Actor } from "@jevitate/screenplay";
import { BrowseTheWebToken, EnterSecret } from "@jevitate/screenplay";
import type { RunPolicy } from "@jevitate/domain";
import { deriveParamSchema, validateParams, type Journey, type SecretRef } from "@jevitate/journey";
import { RecordingInterpreter, checkAssertion, descriptorToTarget, type InterpretResult } from "@jevitate/interpreter";
import {
  SecretOriginMismatchError,
  SecretAmbiguousBindingError,
  assertOriginBound,
  type SecretManagerPort,
} from "@jevitate/secrets";
import { PolicyEnforcementError } from "./runner.js";

/**
 * The runner's OWN result type. Deliberately distinct from the interpreter's
 * `InterpretResult` (which has "completed"/"awaiting_human"/"failed", never
 * "ok") — see the mapping at the bottom of `run()`. `"ok"` here is the
 * JourneyRunner's success outcome, not a passthrough of anything the
 * interpreter returns.
 */
export type JourneyRunResult =
  | { outcome: "ok"; output: unknown }
  | { outcome: "quarantined"; reason: string; at?: number };

export interface HandbackHandler {
  present(prompt: string): Promise<void>;
}

export interface JourneyRunRequest {
  journey: Journey;
  params: Record<string, string>;
  policy: RunPolicy;
}

/**
 * Invariant #1: a `JourneyRunner` must never run with an absent or partial
 * `RunPolicy`. There is no permissive default here — `safeRunPolicy()` exists
 * in `@jevitate/domain` for callers who want a safe default, but this guard does
 * not reach for it itself; it only ever accepts or rejects what the caller
 * supplied.
 */
function assertCompletePolicy(p: RunPolicy | undefined): asserts p is RunPolicy {
  if (!p || !p.selfHeal?.mode || !p.direction?.direction || !p.secret?.secretMode) {
    throw new PolicyEnforcementError(
      "JourneyRunner requires a complete RunPolicy (selfHeal, direction, secret) — refusing to run with an absent/partial policy",
    );
  }
}

export class JourneyRunner {
  constructor(
    private readonly actor: Actor,
    private readonly interpreter: RecordingInterpreter,
    private readonly handback?: HandbackHandler,
    private readonly secretManager?: SecretManagerPort,
  ) {}

  /**
   * Known limitation (Slice 1, documentation-only): when a `handback` step is
   * hit, resuming via `interpreter.resumeFrom` re-seeds only `req.params` —
   * NOT any vars the interpreter had accumulated (e.g. from `extract` steps)
   * before the handback. This is because `InterpretResult`'s
   * `"awaiting_human"` variant carries no `vars` snapshot yet, so the runner
   * has nothing to seed the resume with beyond the original params. This is
   * acceptable for Slice 1's params-only journeys; a future slice should add
   * a vars-seed to `InterpretResult.awaiting_human` and thread it through
   * here.
   */
  async run(req: JourneyRunRequest): Promise<JourneyRunResult> {
    assertCompletePolicy(req?.policy); // #1 — fires before ANY interpreter call
    validateParams(deriveParamSchema(req.journey.recording), req.params); // #5 — before any step

    if (req.policy.secret.secretMode === "vault-autofill") {
      await this.preflightSecretRefs(req.journey.metadata.secretRefs ?? []);
    }

    let result = await this.interpreter.run(this.actor, req.journey.recording, req.params);

    while (result.outcome === "awaiting_human") {
      if (req.policy.secret.secretMode === "vault-autofill") {
        const refusal = await this.fillViaVaultAutofill(req, result);
        if (refusal) return refusal; // quarantined — bail out, never assume success
        result = await this.interpreter.resumeFrom(this.actor, req.journey.recording, result.at + 1, req.params);
        continue;
      }

      // #7: a handback (secret) step. Only proceed if policy explicitly
      // opts into a visible handback AND a handler is wired up; otherwise
      // fail closed — never assume a human will show up.
      if (req.policy.secret.secretMode !== "visible-handback" || !this.handback) {
        return {
          outcome: "quarantined",
          reason: "secret step reached under fail-closed/unattended secretMode",
          at: result.at,
        };
      }
      await this.handback.present(result.prompt); // human enters the secret in the headed browser; we never hold it
      const ok = await checkAssertion(this.actor, result.resume); // verify BEFORE resuming — never assume-success
      if (!ok) {
        return {
          outcome: "quarantined",
          reason: `handback resume postcondition not satisfied at step ${result.at}`,
          at: result.at,
        };
      }
      result = await this.interpreter.resumeFrom(this.actor, req.journey.recording, result.at + 1, req.params);
      // loop: a resumed run may hit another handback.
    }

    // Ruling 3: the interpreter's result has NO "ok" outcome — map explicitly.
    if (result.outcome === "completed") {
      return { outcome: "ok", output: result.vars };
    }
    // result.outcome === "failed"
    return { outcome: "quarantined", reason: `step ${result.at} failed: ${result.error}`, at: result.at };
  }

  /** §9a invariant #4: preflight — every declared secretRef must resolve
   * BEFORE any step runs. A missing SecretManagerPort under vault-autofill
   * is itself an unenforceable policy (mirrors PolicyEnforcementError's
   * existing "declared hard limit we cannot enforce" pattern in
   * runner.ts) and fails closed the same way — never a permissive skip. */
  private async preflightSecretRefs(refs: SecretRef[]): Promise<void> {
    if (!this.secretManager) {
      throw new PolicyEnforcementError(
        "RunPolicy declares secretMode: vault-autofill but this JourneyRunner has no SecretManagerPort wired up — refusing to run (fail-closed)",
      );
    }
    for (const ref of refs) {
      await this.secretManager.assertResolvable(ref); // throws SecretUnresolvableError, never a silent skip
    }
  }

  /**
   * §9a invariants #2/#3: fetches the secret ONLY at the moment of fill,
   * types it directly into the recorded field via the actor, and holds the
   * plaintext in nothing but this method's own local bindings — never in
   * `JourneyRunResult`, never logged, never passed to `resumeFrom`'s
   * `params`. Returns a `{outcome:"quarantined",...}` result when it
   * refuses to fill for a reason that is not itself a hard invariant
   * breach (only `SecretOriginMismatchError` — thrown, not returned — is
   * that); returns `undefined` on a successful fill so the caller's loop
   * proceeds to `resumeFrom`.
   *
   * RULING (Slice 1b scope): vault-autofill can only locate the field to
   * type into when the handback step's `resume` assertion is
   * `{kind:"visible", target}` — exactly what the recorder emits for a
   * real secret field (see `packages/recorder/src/assemble.ts`'s
   * `buildStep`: `resume: visible(resolution.descriptor)`). Any other
   * `resume` shape reaching here has no field to fill programmatically, so
   * it fails closed rather than guessing.
   *
   * RULING (Slice 1b scope): exactly one declared `SecretRef` must match
   * the current page's origin. Zero matches is an origin mismatch
   * (`SecretOriginMismatchError`); more than one match is a DIFFERENT
   * failure — the origins did match, but which one to fill is ambiguous
   * (`SecretAmbiguousBindingError`, review-round-1 fix: these were
   * previously conflated under one error). Both fail closed.
   *
   * RULING (Slice 1b scope, review-round-1 Finding 2): the resolved
   * `SecretRef.field` is NOT compared against the fill target in this
   * slice — it is not enforced, only carried for a future slice's use.
   * There is no established mapping between a password manager's free-form
   * field name (e.g. "password") and a `TargetDescriptor`'s selector rungs
   * (testId/role+name/label/text/css — see `descriptorToTarget`), and
   * inventing one now would be an unreviewed contract change. The ONLY
   * binding this slice enforces is origin (via `assertOriginBound`, plus
   * "exactly one same-origin ref" above) — disambiguating multiple
   * same-origin secrets by field is explicitly out of scope here. Do not
   * describe this method elsewhere as verifying "origin+field binding";
   * it verifies origin binding only.
   */
  private async fillViaVaultAutofill(
    req: JourneyRunRequest,
    result: Extract<InterpretResult, { outcome: "awaiting_human" }>,
  ): Promise<JourneyRunResult | undefined> {
    if (result.resume.kind !== "visible") {
      return {
        outcome: "quarantined",
        reason: `vault-autofill: handback resume is not a "visible" target assertion at step ${result.at} — cannot locate a field to fill`,
        at: result.at,
      };
    }

    const page = this.actor.ability(BrowseTheWebToken).session.page;
    const currentUrl = page.url();
    const refs = req.journey.metadata.secretRefs ?? [];
    const matching = refs.filter((ref) => {
      try {
        assertOriginBound(ref, currentUrl);
        return true;
      } catch {
        return false;
      }
    });
    if (matching.length === 0) {
      throw new SecretOriginMismatchError(
        `vault-autofill: no declared secretRef is bound to the current origin (${currentUrl})`,
      );
    }
    if (matching.length > 1) {
      throw new SecretAmbiguousBindingError(
        `vault-autofill: ${matching.length} declared secretRefs are bound to the current origin (${currentUrl}) — ambiguous, refusing to guess which one to fill (disambiguating multiple same-origin secrets by field is out of scope for this slice)`,
      );
    }
    const ref = matching[0];

    const fieldVisible = await checkAssertion(this.actor, result.resume);
    if (!fieldVisible) {
      return {
        outcome: "quarantined",
        reason: `vault-autofill: expected credential field not visible before fill at step ${result.at}`,
        at: result.at,
      };
    }

    const secret = await this.secretManager!.fetch(ref); // preflight already proved this resolves
    const target = descriptorToTarget(result.resume.target);
    // EnterSecret (not Enter.theText): Enter.theText's description
    // interpolates the raw value, which would leak the secret's plaintext
    // into an Activity.description; EnterSecret's description is always
    // redacted (see @jevitate/screenplay's interactions.ts).
    await EnterSecret.theSecret(secret).into(target).performAs(this.actor);
    return undefined;
  }
}
