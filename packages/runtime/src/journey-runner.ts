import type { Actor } from "@jevitate/screenplay";
import { BrowseTheWebToken, EnterSecret } from "@jevitate/screenplay";
import { clock, type RunPolicy } from "@jevitate/domain";
import { deriveParamSchema, secretParamValues, validateParams, type Journey, type SecretRef } from "@jevitate/journey";
import { RecordingInterpreter, checkAssertion, descriptorToTarget, type InterpretResult, type StepResolution, type StepWait } from "@jevitate/interpreter";
import { RecordingSchema, type Recording, type RecordedStep, type Step } from "@jevitate/recording";
import {
  SecretOriginMismatchError,
  SecretAmbiguousBindingError,
  assertOriginBound,
  type SecretManagerPort,
} from "@jevitate/secrets";
import { PolicyEnforcementError } from "./policy-error.js";
import {
  assertProofUntouched,
  flattenRecording,
  healFloor,
  isGuardedStep,
  retargetRecording,
  type SelfHealer,
  type StepRiskClassifier,
} from "./self-heal.js";
import { EMPTY_CHANGE_SCOPE, type ChangeScope } from "./change-scope.js";
import { explainsBreak as defaultExplainsBreak, newAnchorsInChange, type ExplainsBreak } from "./change-scope-explain.js";
import { DEFAULT_HEAL_BUDGET, HealBudgetMeter, type HealBudgetDimension, type HealExhaustion } from "./heal-budget.js";
import {
  evidenceRef,
  sanitizeStep,
  summarizeChangeScope,
  type ChangeEvidenceRef,
  type HealAttempt,
  type HealRejection,
  type HealReport,
  type HealVerdict,
  type ProposedRevisionDraft,
  type ProposedStepChange,
} from "./heal-attempt.js";

/**
 * The runner's OWN result type. Deliberately distinct from the interpreter's
 * `InterpretResult` (which has "completed"/"awaiting_human"/"failed", never
 * "ok") — see the mapping at the bottom of `run()`. `"ok"` here is the
 * JourneyRunner's success outcome, not a passthrough of anything the
 * interpreter returns.
 *
 * #453: a run that only completed because a step was healed is NEVER a pass: it ends
 * `healed-pending-review` with the proposed revision (the stored Journey is untouched until a
 * person accepts it). An explained break whose every candidate was refuted, or whose budget ran
 * out, is `heal-exhausted`. Fold any outcome onto an exit code with `journeyExitCode`.
 */
export type JourneyRunResult = (
  | { outcome: "ok"; output: unknown }
  | { outcome: "healed-pending-review"; output: unknown; revision: ProposedRevisionDraft }
  | { outcome: "heal-exhausted"; reason: string; at: number }
  | { outcome: "quarantined"; reason: string; at?: number }
) & {
  /**
   * #409: the actual outcome wait of each step that declared `waitFor` (in run order; a resumed or
   * healed run's waits included) — a slow job is a performance signal. Absent when no step waited.
   */
  waits?: StepWait[];
  /**
   * #470: how each step's target resolved (one per step: a step re-run by a resume or a heal keeps
   * its last resolution), in step order. Metadata for locator health; absent when none resolved.
   */
  resolved?: StepResolution[];
  /** #453: what the self-heal did — present when the policy allowed one and a step broke. */
  heal?: HealReport;
};

export interface HandbackHandler {
  present(prompt: string): Promise<void>;
}

export interface JourneyRunRequest {
  journey: Journey;
  params: Record<string, string>;
  policy: RunPolicy;
}

/** A mutating request the write blocker aborted during a guarded probe. */
export interface BlockedWriteRef {
  readonly method: string;
  readonly url: string;
}

/**
 * #453 (Q2): the write blocker a guarded click/fill probe runs under. `armAt(i)` blocks every
 * mutating request (and WebSocket send) from then until `disarm()`, which stops and returns what it
 * blocked. Any blocked request rejects the candidate (`write-attempted`). `unguardable()`, asked
 * before the probe, names why the page cannot be guarded (e.g. a service worker could send
 * requests the blocker never sees) — the candidate is then rejected `write-attempted` unprobed.
 */
export interface HealWriteGuard {
  armAt(flatIndex: number): Promise<void>;
  disarm(): Promise<readonly BlockedWriteRef[]>;
  unguardable?(): Promise<string | null>;
}

/** #453: the change-aware self-heal wiring of a `JourneyRunner` (its 6th constructor argument). */
export interface JourneyHealOptions {
  /** The change context. Absent / empty → every break is unexplained (quarantined), never healed. */
  readonly scope: ChangeScope;
  /** The explained-ness predicate (default: the deterministic `explainsBreak`). */
  readonly explainsBreak?: ExplainsBreak;
  /** Captures an attempt's evidence after its probe (paths under the run's logs). Errors are ignored. */
  readonly observe?: (actor: Actor, at: { readonly stepIndex: number; readonly attempt: number }) => Promise<{ screenshot?: string; snapshot?: string } | undefined>;
  /** The risky/irreversible classification of a click/fill control. Absent → no click/fill is healed. */
  readonly riskOf?: StepRiskClassifier;
  /** The write blocker for a guarded click/fill probe. Absent → no click/fill is healed. */
  readonly writeGuard?: HealWriteGuard;
  /** Handed to the model healer. */
  readonly allowedOrigins?: readonly string[];
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

/** One run's heal state. */
interface HealSession {
  readonly mode: "hybrid" | "full";
  readonly scope: ChangeScope;
  readonly meter: HealBudgetMeter;
  readonly attempts: HealAttempt[];
  readonly changes: ProposedStepChange[];
  readonly processed: Set<number>;
  exhaustedBy?: HealBudgetDimension;
  touched: boolean;
}

interface QueuedCandidate {
  readonly step: Step;
  readonly hypothesis: string;
  readonly source: HealAttempt["source"];
  readonly evidence: readonly ChangeEvidenceRef[];
  usage: { modelCalls: number; tokens?: number; ms: number };
}

type ProbeOutcome =
  | { kind: "accepted"; attempt: HealAttempt; recording: Recording; probe: InterpretResult }
  | { kind: "rejected" | "write-attempted" | "budget-exhausted"; attempt: HealAttempt };

type HealStepOutcome =
  | { readonly kind: "accepted"; readonly recording: Recording; readonly next: InterpretResult }
  | { readonly kind: "stop"; readonly result: JourneyRunResult; readonly verdict: HealVerdict; readonly reason: string };

const REJECTION_OF_TARGET_FAILURE: Readonly<Record<string, HealRejection>> = {
  "replay-target-not-found": "no-match",
  ambiguous: "ambiguous",
};

/** `step 3 "Create" (click)` — how a heal reason names the broken step. */
function nameStep(index: number, recorded: RecordedStep): string {
  const label = [recorded.step.label, recorded.objective].map((t) => (t ?? "").trim()).find((t) => t !== "");
  return `step ${index + 1}${label === undefined ? "" : ` "${label}"`} (${recorded.step.kind})`;
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
    private readonly heal?: JourneyHealOptions,
  ) {}

  /**
   * #453: probes that outlived their heal deadline. The attempt was already rejected
   * (`budget-exhausted`); the probe's write guard stays armed until the probe settles, and `run()`
   * does not return before that — nothing it does after its deadline is ever unguarded.
   */
  #dangling: Promise<void>[] = [];

  /**
   * Known limitation (Slice 1, documentation-only): when a `handback` step is
   * hit, resuming via `interpreter.resumeFrom` re-seeds only `req.params` —
   * NOT any vars the interpreter had accumulated (e.g. from `extract` steps)
   * before the handback. This is because `InterpretResult`'s
   * `"awaiting_human"` variant carries no `vars` snapshot yet, so the runner
   * has nothing to seed the resume with beyond the original params. This is
   * acceptable for Slice 1's params-only journeys; a future slice should add
   * a vars-seed to `InterpretResult.awaiting_human` and thread it through
   * here. (The same holds for a heal probe's resume.)
   */
  async run(req: JourneyRunRequest): Promise<JourneyRunResult> {
    // #409: every interpreter pass's step waits, reported on whatever result the run ends with.
    const waits: StepWait[] = [];
    const resolvedByStep = new Map<number, StepResolution>();
    const collect = (r: InterpretResult): InterpretResult => {
      waits.push(...(r.waits ?? []));
      for (const res of r.resolved ?? []) resolvedByStep.set(res.index, res);
      return r;
    };
    let out: JourneyRunResult;
    try {
      out = await this.#run(req, collect);
    } finally {
      await Promise.all(this.#dangling.splice(0));
    }
    const withWaits = waits.length === 0 ? out : { ...out, waits };
    const resolved = [...resolvedByStep.values()].sort((a, b) => a.index - b.index);
    return resolved.length === 0 ? withWaits : { ...withWaits, resolved };
  }

  async #run(req: JourneyRunRequest, collect: (r: InterpretResult) => InterpretResult): Promise<JourneyRunResult> {
    assertCompletePolicy(req?.policy); // #1 — fires before ANY interpreter call
    validateParams(deriveParamSchema(req.journey.recording), req.params); // #5 — before any step

    if (req.policy.secret.secretMode === "vault-autofill") {
      await this.preflightSecretRefs(req.journey.metadata.secretRefs ?? []);
    }

    // The recording is mutable across the run: an accepted heal retargets one step of it
    // one-for-one (see #healStep). It starts as the Journey's own recording; a clean run never
    // mutates it, and the stored Journey is never written here.
    let recording: Recording = req.journey.recording;
    let result = collect(await this.interpreter.run(this.actor, recording, req.params));
    const mode = req.policy.selfHeal.mode;
    const session: HealSession | undefined =
      mode === "fail-closed"
        ? undefined
        : {
            mode,
            scope: this.heal?.scope ?? EMPTY_CHANGE_SCOPE,
            meter: new HealBudgetMeter(req.policy.selfHeal.budget ?? DEFAULT_HEAL_BUDGET),
            attempts: [],
            changes: [],
            processed: new Set(),
            touched: false,
          };
    let lastVerdict: { verdict: HealVerdict; reason?: string } = { verdict: "not-needed" };
    const finish = (r: JourneyRunResult): JourneyRunResult =>
      session === undefined || !session.touched ? r : { ...r, heal: this.#report(session, lastVerdict.verdict, lastVerdict.reason) };

    for (;;) {
      if (result.outcome === "awaiting_human") {
        if (req.policy.secret.secretMode === "vault-autofill") {
          const refusal = await this.fillViaVaultAutofill(req, result);
          if (refusal) return finish(refusal); // quarantined — bail out, never assume success
          result = collect(await this.interpreter.resumeFrom(this.actor, recording, result.at + 1, req.params));
          continue;
        }

        // #7: a handback (secret) step. Only proceed if policy explicitly
        // opts into a visible handback AND a handler is wired up; otherwise
        // fail closed — never assume a human will show up.
        if (req.policy.secret.secretMode !== "visible-handback" || !this.handback) {
          return finish({
            outcome: "quarantined",
            reason: "secret step reached under fail-closed/unattended secretMode",
            at: result.at,
          });
        }
        await this.handback.present(result.prompt); // human enters the secret in the headed browser; we never hold it
        const ok = await checkAssertion(this.actor, result.resume); // verify BEFORE resuming — never assume-success
        if (!ok) {
          return finish({
            outcome: "quarantined",
            reason: `handback resume postcondition not satisfied at step ${result.at}`,
            at: result.at,
          });
        }
        result = collect(await this.interpreter.resumeFrom(this.actor, recording, result.at + 1, req.params));
        continue; // a resumed run may hit another handback.
      }

      if (result.outcome === "failed") {
        // Invariant #4: fail-closed never heals — quarantine, never mask.
        if (session === undefined) return { outcome: "quarantined", reason: `step ${result.at + 1} failed: ${result.error}`, at: result.at };
        session.touched = true;
        const healed = await this.#healStep(session, req, recording, result);
        if (healed.kind === "stop") {
          lastVerdict = { verdict: healed.verdict, reason: healed.reason };
          return finish(healed.result);
        }
        lastVerdict = { verdict: "proposed" };
        recording = healed.recording;
        result = collect(healed.next);
        continue;
      }

      // result.outcome === "completed" — Ruling 3: the interpreter's result
      // has NO "ok" outcome; map explicitly. A run that only succeeded
      // because of a heal is never collapsed into "ok" (invariant #5): it
      // proposes a revision a person must accept.
      if (session === undefined || session.changes.length === 0) return finish({ outcome: "ok", output: result.vars });
      return finish({ outcome: "healed-pending-review", output: result.vars, revision: { recording, steps: [...session.changes] } });
    }
  }

  #report(s: HealSession, verdict: HealVerdict, reason: string | undefined): HealReport {
    return {
      mode: s.mode,
      verdict,
      ...(reason === undefined ? {} : { reason }),
      changeScope: summarizeChangeScope(s.scope),
      budget: { limits: s.meter.limits, used: s.meter.usage(), ...(s.exhaustedBy === undefined ? {} : { exhaustedBy: s.exhaustedBy }) },
      attempts: [...s.attempts],
    };
  }

  /**
   * #453: heals ONE broken step, or says why not. In order:
   *  1. the floor (`healFloor`): a proof step is never healed; a write/irreversible one neither; a
   *     click/fill only with a risk classification and a write blocker wired (Q2);
   *  2. the budget's broken-step limit;
   *  3. `explainsBreak`: an unexplained break stays `quarantined` (`heal.verdict: "unexplained"`);
   *  4. candidates: the change evidence's deterministic retargets first, then (if a healer is wired
   *     and may be consulted for this step) model candidates — in `hybrid` only those whose new
   *     anchor some evidence `after` names;
   *  5. each candidate (budget checked before it): proof untouched (`assertProofUntouched`), the
   *     floor of its new control, then the probe — the candidate replaces the step one-for-one and
   *     runs ALONE (`runRange`), within the heal deadline; the step's own `expect` must hold. A
   *     guarded probe that sends a mutating request is rejected `write-attempted` and ends the heal;
   *     a probe past the deadline is rejected `budget-exhausted`. Only an accepted probe's step is
   *     charged: the rest of the Journey then replays (`resumeFrom`) outside the heal budget.
   * Every refuted candidate is logged; exhausting them (or the budget) is `heal-exhausted`.
   */
  async #healStep(
    s: HealSession,
    req: JourneyRunRequest,
    recording: Recording,
    failure: Extract<InterpretResult, { outcome: "failed" }>,
  ): Promise<HealStepOutcome> {
    const i = failure.at;
    const failed = `step ${i + 1} failed: ${failure.error}`;
    const quarantine = (verdict: HealVerdict, why: string): HealStepOutcome => ({
      kind: "stop",
      verdict,
      reason: why,
      result: { outcome: "quarantined", reason: `${failed} — ${why}`, at: i },
    });
    const entry = flattenRecording(recording)[i];
    if (entry === undefined) return quarantine("refused-proof", "the failed step is not in the recording");
    if (s.processed.has(i)) return quarantine("exhausted", `${nameStep(i, entry.recorded)} was already healed once in this run`);
    s.processed.add(i);
    const named = nameStep(i, entry.recorded);

    const floor = healFloor(entry.recorded, this.heal?.riskOf);
    if (floor.floor === "proof") return quarantine("refused-proof", `${named}: ${floor.reason}`);
    if (floor.floor !== "healable") return quarantine("refused-write", `${named}: ${floor.reason}`);
    const guarded = isGuardedStep(entry.step);
    const writeGuard = this.heal?.writeGuard;
    if (guarded && writeGuard === undefined) return quarantine("refused-write", `${named}: no write blocker is wired — a ${entry.step.kind} step is not healed`);

    const broke = s.meter.beginStep(i);
    if (broke !== null) {
      s.exhaustedBy = broke.by;
      return { kind: "stop", verdict: "exhausted", reason: `${named}: ${broke.detail}`, result: { outcome: "heal-exhausted", reason: `${failed} — ${broke.detail}`, at: i } };
    }

    const explanation = (this.heal?.explainsBreak ?? defaultExplainsBreak)(entry.step, s.scope);
    if (!explanation.explained) {
      s.meter.endStep();
      return quarantine("unexplained", `${named} is not explained by the change: ${explanation.reason}`);
    }
    const evidence = explanation.evidence.map(evidenceRef);
    const queue: QueuedCandidate[] = explanation.candidates.map((c) => ({
      step: c.step,
      hypothesis: c.hypothesis,
      source: "change-evidence",
      evidence: [evidenceRef(c.evidence)],
      usage: { modelCalls: 0, ms: 0 },
    }));
    const tried: Step[] = [];
    const seen = new Set<string>(queue.map((c) => JSON.stringify(c.step)));
    const healer = this.selfHealer;
    let askModel = healer !== undefined && !(guarded && healer.actsOnPage);
    let budgetOut: HealExhaustion | null = null;
    const secrets = secretParamValues(req.journey, req.params);
    let refuted = 0;

    for (;;) {
      if (queue.length === 0) {
        if (!askModel || healer === undefined) break;
        const noCalls = s.meter.canCallModel();
        if (noCalls !== null) {
          budgetOut = noCalls;
          break;
        }
        const t0 = clock.monotonicMs();
        let fresh: QueuedCandidate[] = [];
        try {
          const proposal = await healer.proposeCandidates({
            actor: this.actor,
            brokenStep: entry.step,
            explanation,
            evidence,
            tried: tried.map(sanitizeStep),
            ...(this.heal?.allowedOrigins === undefined ? {} : { allowedOrigins: this.heal.allowedOrigins }),
            ...(secrets.length === 0 ? {} : { secrets }),
            deadlineAtMs: s.meter.deadlineAtMs(),
            maxModelCalls: s.meter.remainingModelCalls(),
          });
          s.meter.charge(proposal.usage);
          const usage = { modelCalls: proposal.usage.modelCalls, ...(proposal.usage.tokens === undefined ? {} : { tokens: proposal.usage.tokens }), ms: clock.monotonicMs() - t0 };
          fresh = proposal.candidates
            .filter((c) => {
              const key = JSON.stringify(c.step);
              if (seen.has(key)) return false;
              seen.add(key);
              return true;
            })
            .map((c, k) => ({ step: c.step, hypothesis: c.hypothesis, source: "model" as const, evidence, usage: k === 0 ? usage : { modelCalls: 0, ms: 0 } }));
        } catch {
          // A healer failure only ends the model's proposals; the runner still adjudicates. The
          // call is charged anyway: a healer that throws may well have spent a model call.
          s.meter.charge({ modelCalls: 1 });
          fresh = [];
        }
        if (fresh.length === 0) {
          askModel = false;
          continue;
        }
        queue.push(...fresh);
      }
      const exhausted = s.meter.canAttempt();
      if (exhausted !== null) {
        budgetOut = exhausted;
        break;
      }
      const cand = queue.shift()!;
      s.meter.recordAttempt();
      tried.push(cand.step);
      const tryResult = await this.#tryCandidate(s, req, recording, i, entry.recorded, cand, guarded);
      s.attempts.push(tryResult.attempt);
      if (tryResult.kind === "accepted") {
        // Only the candidate step's probe is charged to the heal budget: the clock stops here,
        // before the rest of the Journey replays.
        s.meter.endStep();
        s.changes.push({
          index: i,
          ...(entry.recorded.stepId === undefined ? {} : { stepId: entry.recorded.stepId }),
          before: entry.step,
          after: cand.step,
          attempt: tryResult.attempt.n,
          hypothesis: cand.hypothesis,
          evidence: cand.evidence,
          ...(tryResult.attempt.anchorNotInChange === true ? { anchorNotInChange: true as const } : {}),
        });
        const probe = tryResult.probe;
        const next =
          probe.outcome === "completed" ? await this.interpreter.resumeFrom(this.actor, tryResult.recording, i + 1, probe.vars) : probe;
        const waits = [...(probe.outcome === "completed" ? (probe.waits ?? []) : []), ...(next.waits ?? [])];
        const resolved = [...(probe.outcome === "completed" ? (probe.resolved ?? []) : []), ...(next.resolved ?? [])];
        const merged = waits.length === 0 ? next : { ...next, waits };
        return { kind: "accepted", recording: tryResult.recording, next: resolved.length === 0 ? merged : { ...merged, resolved } };
      }
      refuted++;
      if (tryResult.kind === "write-attempted") {
        s.meter.endStep();
        return quarantine("refused-write", `${named}: ${tryResult.attempt.rejection?.detail ?? "a candidate attempted a write"}`);
      }
      if (tryResult.kind === "budget-exhausted") {
        budgetOut = { by: "wallClock", scope: "step", detail: tryResult.attempt.rejection?.detail ?? "the heal deadline passed during a probe" };
        break;
      }
    }
    s.meter.endStep();
    if (budgetOut !== null) s.exhaustedBy = budgetOut.by;
    const why =
      budgetOut === null
        ? `${named} is explained by the change, but ${refuted === 0 ? "no candidate could be formed" : `all ${refuted} candidate(s) were refuted`}`
        : `${named} is explained by the change, but the heal budget ran out after ${refuted} refuted candidate(s): ${budgetOut.detail}`;
    return { kind: "stop", verdict: "exhausted", reason: why, result: { outcome: "heal-exhausted", reason: `${failed} — ${why}`, at: i } };
  }

  async #tryCandidate(
    s: HealSession,
    req: JourneyRunRequest,
    recording: Recording,
    i: number,
    broken: RecordedStep,
    cand: QueuedCandidate,
    guarded: boolean,
  ): Promise<ProbeOutcome> {
    const t0 = clock.monotonicMs();
    const n = s.attempts.length + 1;
    let flag: { anchorNotInChange?: true } = {};
    let observation: HealAttempt["observation"] | undefined;
    const attempt = (result: "accepted" | "rejected", rejection?: { code: HealRejection; detail: string }): HealAttempt => ({
      n,
      stepIndex: i,
      ...(broken.stepId === undefined ? {} : { stepId: broken.stepId }),
      source: cand.source,
      hypothesis: cand.hypothesis,
      evidence: cand.evidence,
      candidate: sanitizeStep(cand.step),
      ...(observation === undefined ? {} : { observation }),
      ...flag,
      result,
      ...(rejection === undefined ? {} : { rejection }),
      usage: { ...cand.usage, ms: cand.usage.ms + (clock.monotonicMs() - t0) },
    });
    const reject = (code: HealRejection, detail: string): { kind: "rejected"; attempt: HealAttempt } => ({ kind: "rejected", attempt: attempt("rejected", { code, detail }) });

    const proof = assertProofUntouched(broken.step, cand.step);
    if (proof !== null) return reject(proof.code, proof.detail);
    if (cand.source === "model" && !newAnchorsInChange(broken.step, cand.step, cand.evidence)) {
      if (s.mode === "hybrid") return reject("not-explained-by-change", "the candidate's new anchor appears in no change evidence");
      flag = { anchorNotInChange: true };
    }
    if (guarded) {
      const floor = healFloor({ ...broken, step: cand.step }, this.heal?.riskOf);
      if (floor.floor !== "healable") return reject(floor.floor === "write" ? "write-step" : "irreversible", floor.reason);
    }
    const candRecording = retargetRecording(recording, i, cand.step);
    const valid = RecordingSchema.safeParse(candRecording);
    if (!valid.success) return reject("shape-changed", `the candidate is not a valid step: ${valid.error.issues[0]?.message ?? "invalid"}`);

    // The probe runs the candidate step ALONE (the remainder replays after the step's heal clock
    // stopped), within the heal deadline: past it the attempt is rejected `budget-exhausted`.
    const guard = guarded ? this.heal?.writeGuard : undefined;
    let blocked: readonly BlockedWriteRef[] = [];
    const unguardable = guard?.unguardable === undefined ? null : await guard.unguardable().catch((e: unknown) => `the write guard could not inspect the page: ${e instanceof Error ? e.message : String(e)}`);
    if (unguardable !== null) {
      return { kind: "write-attempted", attempt: attempt("rejected", { code: "write-attempted", detail: `the probe cannot be guarded: ${unguardable}` }) };
    }
    if (guard !== undefined) await guard.armAt(i);
    const probe = this.interpreter.runRange(this.actor, candRecording, i, i, req.params);
    let timer: ReturnType<typeof clock.setTimeout> | undefined;
    const deadline = new Promise<"deadline">((resolve) => {
      timer = clock.setTimeout(() => resolve("deadline"), Math.max(0, s.meter.deadlineAtMs() - clock.now()));
    });
    let raced: InterpretResult | "deadline";
    try {
      raced = await Promise.race([probe, deadline]);
    } catch (err) {
      if (guard !== undefined) await guard.disarm();
      throw err;
    } finally {
      clock.clearTimeout(timer);
    }
    if (raced === "deadline") {
      // The probe is still running: its guard stays armed until it settles (`#dangling`).
      this.#dangling.push(
        probe.then(
          () => undefined,
          () => undefined,
        ).then(async () => {
          if (guard !== undefined) await guard.disarm().catch(() => undefined);
        }),
      );
      return { kind: "budget-exhausted", attempt: attempt("rejected", { code: "budget-exhausted", detail: "the heal deadline passed while the candidate was being probed" }) };
    }
    const next: InterpretResult = raced;
    if (guard !== undefined) blocked = await guard.disarm();
    if (this.heal?.observe !== undefined) {
      try {
        const seen = await this.heal.observe(this.actor, { stepIndex: i, attempt: n });
        if (seen !== undefined) observation = seen;
      } catch {
        // Evidence capture never changes the verdict.
      }
    }
    if (blocked.length > 0) {
      const shown = blocked.map((w) => `${w.method.toUpperCase()} ${w.url}`).join(", ");
      return { kind: "write-attempted", attempt: attempt("rejected", { code: "write-attempted", detail: `the probe sent a mutating request (blocked): ${shown}` }) };
    }
    if (next.outcome === "failed" && next.at === i) {
      return reject((next.reason === undefined ? undefined : REJECTION_OF_TARGET_FAILURE[next.reason]) ?? "postcondition-failed", next.error);
    }
    return { kind: "accepted", attempt: attempt("accepted"), recording: candRecording, probe: next };
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
    // #399: messages name the ORIGIN only — the full URL may carry a secret navigate parameter.
    const shownOrigin = originOnly(currentUrl);
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
        `vault-autofill: no declared secretRef is bound to the current origin (${shownOrigin})`,
      );
    }
    if (matching.length > 1) {
      throw new SecretAmbiguousBindingError(
        `vault-autofill: ${matching.length} declared secretRefs are bound to the current origin (${shownOrigin}) — ambiguous, refusing to guess which one to fill (disambiguating multiple same-origin secrets by field is out of scope for this slice)`,
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

/** A URL's origin, or a fixed marker when it has none — never the path or query (#399). */
function originOnly(url: string): string {
  try {
    const o = new URL(url).origin;
    return o === "null" ? "an opaque origin" : o;
  } catch {
    return "an unparseable URL";
  }
}
