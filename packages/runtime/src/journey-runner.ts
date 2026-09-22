import type { Actor } from "@jevitate/screenplay";
import { BrowseTheWebToken, EnterSecret } from "@jevitate/screenplay";
import type { RunPolicy } from "@jevitate/domain";
import { deriveParamSchema, validateParams, type Journey, type SecretRef } from "@jevitate/journey";
import { RecordingInterpreter, checkAssertion, descriptorToTarget, type InterpretResult } from "@jevitate/interpreter";
import type { Recording } from "@jevitate/recording";
import {
  SecretOriginMismatchError,
  SecretAmbiguousBindingError,
  assertOriginBound,
  type SecretManagerPort,
} from "@jevitate/secrets";
import { PolicyEnforcementError } from "./runner.js";
import { isWriteStep, postconditionOf, healRecording, flattenRecording, type SelfHealer } from "./self-heal.js";

/**
 * The runner's OWN result type. Deliberately distinct from the interpreter's
 * `InterpretResult` (which has "completed"/"awaiting_human"/"failed", never
 * "ok") — see the mapping at the bottom of `run()`. `"ok"` here is the
 * JourneyRunner's success outcome, not a passthrough of anything the
 * interpreter returns.
 */
export type JourneyRunResult =
  | { outcome: "ok"; output: unknown }
  | { outcome: "healed"; output: unknown; healedRecording: Recording; healedAt: number }
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

/**
 * Secret-bearing runs must never enable Playwright tracing. `JourneyRunner`
 * itself never calls `session.startTracing()`/`stopTracingToFile()` (that
 * wiring exists only in the separate `Runner`/`ActionRunner` in
 * `runner.ts`, gated on `req.traceDir`) — tracing screenshots/snapshots
 * would capture the vault-autofill fill value, so a `JourneyRunner` caller
 * must not layer tracing onto a session used for a `vault-autofill` or
 * `visible-handback` run. Enforced today by omission + a test asserting
 * `fillViaVaultAutofill` never calls `startTracing` on the actor's session
 * (see vault-autofill.test.ts); if `JourneyRunner` ever grows its own
 * tracing wiring, that wiring must exclude secret-bearing runs.
 */
export class JourneyRunner {
  constructor(
    private readonly actor: Actor,
    private readonly interpreter: RecordingInterpreter,
    private readonly handback?: HandbackHandler,
    private readonly secretManager?: SecretManagerPort,
    private readonly selfHealer?: SelfHealer,
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

    // The recording is mutable across the run because a successful scoped
    // repair splices a re-learned step into it (see tryHeal / healRecording).
    // It starts as the Journey's own recording; a clean (never-healed) run
    // never mutates it.
    let recording: Recording = req.journey.recording;
    let result = await this.interpreter.run(this.actor, recording, req.params);
    let healedAt: number | undefined;
    // RULING (invariant #4 / loop-safety, see report): each step index is
    // healed AT MOST once. If a healed splice, once resumed, itself fails
    // again at the same index, we do NOT re-heal in a loop — we quarantine,
    // exactly as we would have without an attempt.
    const healedIndices = new Set<number>();

    for (;;) {
      if (result.outcome === "awaiting_human") {
        if (req.policy.secret.secretMode === "vault-autofill") {
          const refusal = await this.fillViaVaultAutofill(req, result);
          if (refusal) return refusal; // quarantined — bail out, never assume success
          result = await this.interpreter.resumeFrom(this.actor, recording, result.at + 1, req.params);
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
        result = await this.interpreter.resumeFrom(this.actor, recording, result.at + 1, req.params);
        continue; // a resumed run may hit another handback.
      }

      if (result.outcome === "failed") {
        const healed = await this.tryHeal(req.policy, recording, result.at, healedIndices);
        if (healed) {
          healedAt = result.at;
          healedIndices.add(result.at);
          recording = healed.healedRecording;
          // Resume AT the broken index — the healed recording carries the
          // re-learned replacement step at that same flat position.
          result = await this.interpreter.resumeFrom(this.actor, recording, result.at, req.params);
          continue;
        }
        // Invariant #4: no heal (refused, none wired, write floor, or
        // already-attempted this index) -> quarantine, never mask.
        return { outcome: "quarantined", reason: `step ${result.at} failed: ${result.error}`, at: result.at };
      }

      // result.outcome === "completed" — Ruling 3: the interpreter's result
      // has NO "ok" outcome; map explicitly. A run that only succeeded
      // because of an in-flight repair stays distinguishable ("healed"),
      // never collapsed into "ok" (invariant #5).
      return healedAt === undefined
        ? { outcome: "ok", output: result.vars }
        : { outcome: "healed", output: result.vars, healedRecording: recording, healedAt };
    }
  }

  /**
   * §9a invariant #8 (write floor): a write/irreversible step NEVER
   * auto-heals, in EITHER `hybrid` or `full` mode — only a `RunPolicy` with
   * `selfHeal.mode !== "fail-closed"`, a wired `SelfHealer`, and a
   * READ-ONLY broken step reach the healer at all. Returns `undefined`
   * (never healed) for every other case, including when the healer itself
   * reports `"not-healed"` and when this step index was already healed once
   * (loop-safety per invariant #4). A model/healer judgment NEVER
   * unilaterally applies to a write step — the write floor short-circuits
   * before the healer is ever invoked.
   */
  private async tryHeal(
    policy: RunPolicy,
    recording: Recording,
    brokenFlatIndex: number,
    healedIndices: ReadonlySet<number>,
  ): Promise<{ healedRecording: Recording } | undefined> {
    if (policy.selfHeal.mode === "fail-closed" || !this.selfHealer) return undefined;
    if (healedIndices.has(brokenFlatIndex)) return undefined; // already tried once — no re-heal loop

    const flat = flattenRecording(recording);
    const brokenEntry = flat[brokenFlatIndex];
    if (!brokenEntry) return undefined;
    if (isWriteStep(brokenEntry.step)) return undefined; // the floor — never bypassed by "full"

    const postcondition = postconditionOf(brokenEntry.step);
    if (!postcondition) return undefined;

    const healResult = await this.selfHealer.reLearnStep({
      actor: this.actor,
      brokenStep: brokenEntry.step,
      expectedPostcondition: postcondition,
    });
    if (healResult.outcome !== "healed") return undefined;

    return { healedRecording: healRecording(recording, brokenFlatIndex, healResult.segment) };
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
