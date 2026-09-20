import type { Actor } from "@doit/screenplay";
import type { RunPolicy } from "@doit/domain";
import { deriveParamSchema, validateParams, type Journey, type SecretRef } from "@doit/journey";
import { RecordingInterpreter, checkAssertion, type InterpretResult } from "@doit/interpreter";
import type { SecretManagerPort } from "@doit/secrets";
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
 * in `@doit/domain` for callers who want a safe default, but this guard does
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
}
