/**
 * #402 — `journey verify --mutate`: a built-in negative proof that each of a Journey's assertions
 * FAILS when its outcome is absent. The Journey is replayed once as recorded (it must pass), then
 * once per mutation (`planJourneyMutations`: skip a write step, abort its writes, type an empty or
 * stale value into a checked fill, or — #565 — swap or truncate a checked non-secret parameter); each assertion is sensitive only when its paired mutation broke it, at
 * that assertion, with nothing failing before the mutated step.
 *
 * Every replay goes through `runJourneyProgrammatically` — the same path, gate, fixtures and
 * environment as `journey run`. Mutations never send, fabricate or answer a request: they leave a
 * step's action out, ABORT the app's own writes in one step's window, or type `""`.
 */
import {
  FsJourneyStore,
  JourneyRegistry,
  assertionSiteKey,
  classifyMutation,
  declaredTargetedProofFor,
  journeyAssertions,
  judgeAssertions,
  mutationProofVerdict,
  mutationReplay,
  mutationWriteMatches,
  needsRelaxedReplay,
  needsFinalNetworkObservation,
  planJourneyMutations,
  relaxedMutationReplay,
  runDeclaredTargetedProof,
  runTargetedProof,
  suggestTargetedProofPlan,
  type AssertionVerdict,
  type AssertionProof,
  type Journey,
  type JourneyMutation,
  type JourneyTargetedProofPlan,
  type MutationFailedSite,
  type MutationProofVerdict,
  type MutationReplay,
  type MutationRunResult,
  type TargetedProof,
} from "@jevitate/journey";
import { describeCheck, type BlockedWrite } from "@jevitate/explore";
import { clock } from "@jevitate/domain";
import { journeyContentHash } from "./journey-annotate-api.js";
import { journeyReviewHash } from "./journey-review.js";
import { preflightVerifyRecord, writePreflightedVerifyRecord } from "./journey-review-store.js";
import type { StepObserver } from "@jevitate/interpreter";
import { UnknownJourneyError, redactSecretParams, runJourneyProgrammatically, type RunJourneyProgrammaticallyOptions } from "./journey-api.js";
import type { OutcomeCheckFailure } from "./journey-network-checks.js";
import { journeyProofContext, journeyExecutionIdentity, type JourneyExecutionIdentity } from "./journey-proof-context.js";

/** `journey run`'s options a proof passes through to every replay (params, environment, auth, fixtures, browser, gate). */
export type VerifyJourneyOptions = Omit<
  RunJourneyProgrammaticallyOptions,
  "stopAfterStep" | "interpreter" | "observer" | "session" | "screenshots" | "actionDeltas" | "selfHealer" | "policy"
> & {
  /** Read patterns for the write classifier (as `journey lint`). */
  readonly readRequests?: readonly string[];
};

export interface JourneyVerifyMutation {
  readonly kind: JourneyMutation["kind"];
  readonly step: number;
  readonly id: string;
  /** #565: the parameter a `swap-param`/`truncate-param` altered (its name, never a value). */
  readonly param?: string;
  /** #579: where a `swap-param`'s wrong value came from (`reviewed`, `option`, `generated`), never the value. */
  readonly source?: JourneyMutation["source"];
  readonly outcome: MutationRunResult["outcome"];
  readonly failedSites: readonly MutationFailedSite[];
  /** block-write: what was aborted (`METHOD path`). */
  readonly blockedWrites?: readonly string[];
  /** Why the replay failed, was not applied, or errored. */
  readonly reason?: string;
  /**
   * #554 — the same mutation replayed with the mutated step's own postcondition relaxed, present
   * only when the first replay failed at that postcondition and a later site is paired with it.
   */
  readonly relaxed?: {
    readonly outcome: MutationRunResult["outcome"];
    readonly failedSites: readonly MutationFailedSite[];
    readonly blockedWrites?: readonly string[];
    readonly reason?: string;
  };
  /** #609: targeted proofs run for assertion sites this mutation left as a cascade. */
  readonly targeted?: readonly TargetedProof[];
}

export interface JourneyVerifyAssertion {
  readonly site: string;
  /** The assertion, in the `--success` spec syntax. */
  readonly check: string;
  readonly verdict: AssertionVerdict;
  readonly provedBy?: string;
  /** #609: the earlier postconditions a targeted proof weakened to reach a sensitive verdict. */
  readonly relaxedSites?: readonly string[];
  /** #609: why a targeted proof was refused, when the verdict stays a cascade. */
  readonly targetedRefusal?: string;
  /** #616: the proving targeted proof came from a declared `metadata.targetedProofs` plan. */
  readonly declaredProof?: true;
  readonly obligations?: readonly (NonNullable<AssertionProof["obligations"]>[number] & { readonly declaredProof?: true })[];
}

export interface JourneyVerifyReport {
  readonly journeyId: string;
  /** `journeyContentHash` of the stored Journey: the proof is bound to exactly this content. */
  readonly journeyHash: string;
  readonly executionIdentity: JourneyExecutionIdentity;
  readonly base: { readonly outcome: string; readonly reason?: string };
  readonly verdict: MutationProofVerdict;
  readonly reason?: string;
  readonly mutations: readonly JourneyVerifyMutation[];
  readonly assertions: readonly JourneyVerifyAssertion[];
  readonly summary: Readonly<Record<"sensitive" | "insensitive" | "cascade" | "notApplied" | "error" | "unpaired" | "targeted", number>>;
  /** #616: a reviewable `metadata.targetedProofs` entry for each automatic proof stopped at its bound. */
  readonly suggestedTargetedProofs?: readonly JourneyTargetedProofPlan[];
}

export interface JourneyVerifyPlanReport {
  readonly journeyId: string;
  /** `journeyContentHash` of the stored Journey: the preview is bound to exactly this content. */
  readonly journeyHash: string;
  readonly executionIdentity: JourneyExecutionIdentity;
  readonly mutations: readonly Pick<JourneyMutation, "kind" | "step" | "id" | "param" | "source">[];
  readonly pairs: readonly { readonly site: string; readonly check: string; readonly mutation: string; readonly declared?: true }[];
  readonly assertions: readonly { readonly site: string; readonly check: string; readonly mutations: readonly string[] }[];
  readonly summary: Readonly<Record<"mutations" | "pairs" | "assertions" | "unpaired" | "minimumReplays", number>>;
}

/**
 * Static preview of `journey verify --mutate`: CLI resolves local target policy; no browser, fixtures, hooks, target network, session or
 * credential is opened. Values of params are used only to derive the plan and are never returned.
 */
export async function planJourneyVerification(
  opts: Pick<VerifyJourneyOptions, "dir" | "id" | "params" | "readRequests" | "browser" | "emulation">,
): Promise<JourneyVerifyPlanReport> {
  const journey = await new JourneyRegistry(new FsJourneyStore(opts.dir)).get(opts.id);
  if (!journey) throw new UnknownJourneyError(`unknown journey '${opts.id}'`);
  const sites = journeyAssertions(journey);
  const checkOf = new Map(sites.map((site) => [assertionSiteKey(site), describeCheck(site.check)]));
  const plan = planJourneyMutations(journey, {
    ...(opts.readRequests === undefined ? {} : { readRequests: opts.readRequests }),
    params: opts.params,
  });
  const pairs = plan.pairs.map((pair) => ({ ...pair, check: checkOf.get(pair.site) ?? "unknown assertion" }));
  const assertions = sites.map((site) => {
    const key = assertionSiteKey(site);
    return { site: key, check: describeCheck(site.check), mutations: pairs.filter((pair) => pair.site === key).map((pair) => pair.mutation) };
  });
  return {
    journeyId: journey.metadata.id,
    journeyHash: journeyContentHash(journey),
    executionIdentity: journeyExecutionIdentity(journey, journeyProofContext(opts.browser, opts.emulation, opts.readRequests)),
    mutations: plan.mutations,
    pairs,
    assertions,
    summary: {
      mutations: plan.mutations.length,
      pairs: pairs.length,
      assertions: assertions.length,
      unpaired: assertions.filter((assertion) => assertion.mutations.length === 0).length,
      minimumReplays: plan.mutations.length + 1,
    },
  };
}

/** The exit code for a proof's verdict (docs/ci.md): 0 proven · 1 insensitive · 2 inconclusive. */
export function verifyExitCode(verdict: MutationProofVerdict): number {
  return verdict === "proven" ? 0 : verdict === "insensitive" ? 1 : 2;
}

type Run = typeof runJourneyProgrammatically;

const REQUEST_LINE = /^(\S+)\s+(\S+)/;

/** Only a positively matching recorded or declared write establishes applicability. */
function blockedOwnWrite(recorded: readonly string[], declared: NonNullable<MutationReplay["blockMatchers"]>, blocked: readonly BlockedWrite[]): boolean {
  const observed = recorded.flatMap((line) => {
    const m = REQUEST_LINE.exec(line.trim());
    return m === null ? [] : [{ method: m[1]!, pathGlob: m[2]!, literal: true as const }];
  });
  return [...observed, ...declared].some((matcher) => blocked.some((request) => mutationWriteMatches(matcher, request)));
}

function failedSitesOf(result: { outcome: string; reason?: string; at?: number; failurePhase?: "action" | "postcondition" }, failures: readonly OutcomeCheckFailure[]): MutationFailedSite[] {
  if (result.outcome !== "quarantined") return [];
  const structured = failures.map((f): MutationFailedSite =>
    f.where === "step-request" ? { where: "step-request", step: f.step, checkIndex: f.checkIndex, ...(f.evaluated === true ? { evaluated: true } : {}) } : f.where === "end-state" ? { where: "end-state", index: f.index } : { where: "unevaluable" },
  );
  return result.at === undefined ? structured : [...structured, { where: "step", step: result.at + 1, postcondition: result.failurePhase === "postcondition" }];
}

/** Corresponding top-level boundaries only; admission and cleanup never enter this record. */
function finalObservation(stepCount: number): {
  anchors: number[]; valid: boolean; finalDone: boolean; closes: number; close?: number;
  observer: StepObserver; captureClose: () => Promise<void>;
} {
  const record = {
    anchors: [] as number[], valid: true, finalDone: false, closes: 0,
    close: undefined as number | undefined,
    observer: {} as StepObserver,
    captureClose: async (): Promise<void> => {
      const now = clock.monotonicMs();
      record.closes++;
      if (record.closes !== 1 || !Number.isFinite(now) || now < 0 || now < (record.anchors.at(-1) ?? now)) record.valid = false;
      record.close = now;
    },
  };
  record.observer = {
    beforeStep: async ({ index }) => {
      const now = clock.monotonicMs();
      if (index !== record.anchors.length || index >= stepCount || !Number.isFinite(now) || now < 0 || now < (record.anchors.at(-1) ?? now)) { record.valid = false; return; }
      record.anchors.push(now);
    },
    afterStep: async ({ index, outcome }) => {
      if (index === stepCount - 1) record.finalDone = outcome === "done";
    },
  };
  return record;
}

/**
 * Runs the proof for one Journey by id. Usage errors (unknown id, bad params, an environment that
 * refuses a step, a site-gate refusal) throw exactly as `journey run`'s do, before any mutation.
 */
export async function verifyJourneyMutations(opts: VerifyJourneyOptions, run: Run = runJourneyProgrammatically): Promise<JourneyVerifyReport> {
  const journey = await new JourneyRegistry(new FsJourneyStore(opts.dir)).get(opts.id);
  if (!journey) throw new UnknownJourneyError(`unknown journey '${opts.id}'`);
  // #711: receipt authority is proven before the first baseline/mutation replay spends a browser.
  const receiptDestination = await preflightVerifyRecord(opts.dir, journey.metadata.id);
  const { readRequests, ...runOpts } = opts;
  const lintOpts = readRequests === undefined ? {} : { readRequests };
  const journeyHash = journeyContentHash(journey);
  const proofContext = journeyProofContext(opts.browser, opts.emulation, opts.readRequests);
  const executionIdentity = journeyExecutionIdentity(journey, proofContext);

  const stepCount = journey.recording.pages.reduce((n, page) => n + page.steps.length, 0);
  const baseline = needsFinalNetworkObservation(journey) ? finalObservation(stepCount) : undefined;
  const base = await run(baseline === undefined ? runOpts : { ...runOpts, observer: baseline.observer }, {
    structuredFailures: true,
    ...(baseline === undefined ? {} : { beforeFinalNetworkCaptureClose: baseline.captureClose }),
  });
  const baseFields = { outcome: base.outcome, ...(base.outcome === "quarantined" ? { reason: base.reason } : {}) };
  const sites = journeyAssertions(journey);
  const checkOf = new Map(sites.map((s) => [assertionSiteKey(s), describeCheck(s.check)]));
  const plan = planJourneyMutations(journey, { ...lintOpts, params: opts.params });

  const mutations: JourneyVerifyMutation[] = [];
  // #616: automatic targeted proofs stopped at their relaxation bound, each a reviewable start.
  const suggested: JourneyTargetedProofPlan[] = [];
  const seenSuggestions = new Set<string>();
  if (base.outcome === "ok") {
    // One mutated replay, as `mutationReplay` (or #554's `relaxedMutationReplay`) describes it.
    type Replayed = NonNullable<JourneyVerifyMutation["relaxed"]>;
    // #565: a param mutation's replay runs with altered params (never a secret's), so it needs them.
    const replayOpts = { ...lintOpts, params: opts.params };
    // The replay is DESCRIBED, not fixed: `mutateJourney` re-describes it on the Journey the run moved
    // onto the environment (#247), so a mutated copy never drops `--env`/`--base-url`.
    const runReplay = async (m: JourneyMutation, describe: (j: Journey) => MutationReplay, holdRequired: boolean): Promise<Replayed> => {
      try {
        const how = describe(journey);
        const observed = holdRequired ? finalObservation(stepCount) : undefined;
        let horizonComplete = !holdRequired;
        let horizonSleeps = 0;
        let horizonElapsed = 0;
        let horizonRequired = 0;
        let horizonCause: "missing-observer" | "sleep-failed" | "clock-no-progress" | "clock-invalid" | "wake-limit" | "incomplete" = "missing-observer";
        const captureClose = async (): Promise<void> => {
          if (observed === undefined || baseline === undefined) return;
          await observed.captureClose();
          if (!baseline.valid || !observed.valid) { horizonCause = "clock-invalid"; return; }
          if (baseline.close !== undefined) horizonRequired = Math.max(0, ...baseline.anchors.slice(0, m.step).map((before) => baseline.close! - before));
          if (baseline.close === undefined || baseline.closes !== 1 || !baseline.finalDone || baseline.anchors.length !== stepCount || !observed.finalDone || observed.anchors.length !== stepCount) return;
          horizonCause = "incomplete";
          try {
            let now = clock.monotonicMs();
            if (observed.close === undefined || !Number.isFinite(observed.close) || !Number.isFinite(now) || now < observed.close) {
              horizonCause = "clock-invalid";
              return;
            }
            for (;;) {
              let remaining = 0;
              horizonElapsed = Number.POSITIVE_INFINITY;
              for (let index = 0; index < m.step; index++) {
                const before = baseline.anchors[index];
                const replayBefore = observed.anchors[index];
                if (before === undefined || replayBefore === undefined) { horizonCause = "missing-observer"; return; }
                const required = baseline.close - before;
                const elapsed = now - replayBefore;
                if (![now, required, elapsed].every(Number.isFinite) || required < 0 || elapsed < 0) { horizonCause = "clock-invalid"; return; }
                horizonRequired = Math.max(horizonRequired, required);
                horizonElapsed = Math.min(horizonElapsed, elapsed);
                remaining = Math.max(remaining, required - elapsed);
              }
              if (remaining <= 0) { horizonComplete = true; return; }
              if (horizonSleeps >= 8) { horizonCause = "wake-limit"; return; }
              const previous = now;
              horizonSleeps++;
              try { await clock.sleep(Math.ceil(remaining)); }
              catch { horizonCause = "sleep-failed"; return; }
              now = clock.monotonicMs();
              if (!Number.isFinite(now) || now < previous) { horizonElapsed = now; horizonCause = "clock-invalid"; return; }
              if (now === previous) { horizonCause = "clock-no-progress"; return; }
            }
          } catch { horizonCause = "clock-invalid"; }
        };
        const held = observed === undefined ? runOpts : { ...runOpts, observer: observed.observer };
        const r = await run(how.params === undefined ? held : { ...held, params: { ...how.params } }, {
          structuredFailures: true,
          ...(observed === undefined ? {} : { beforeFinalNetworkCaptureClose: captureClose }),
          ...(readRequests === undefined ? {} : { readRequests }),
          ...(how.relaxedStepRequests === undefined ? {} : { relaxedStepRequests: how.relaxedStepRequests }),
          ...(how.journey === journey ? {} : { mutateJourney: (j) => describe(j).journey }),
          ...(how.skipIndex === undefined ? {} : { skipStep: (i: number) => i === how.skipIndex }),
          ...(how.swapSelectAtStep === undefined ? {} : { selectAlternativeAtStep: how.swapSelectAtStep }),
          ...(how.blockIndex === undefined ? {} : { blockWritesAtStep: how.blockIndex }),
        });
        if (holdRequired && r.outcome === "heal-exhausted") {
          return { outcome: "failed", failedSites: [{ where: "step", step: r.at + 1, postcondition: false }], reason: r.reason };
        }
        // A replay that stopped at a step retains its original failure/cascade. A result at
        // the final-check boundary needs the completed hold, even when the observer was skipped.
        if (holdRequired && (!horizonComplete || observed?.valid !== true || observed.closes !== 1 || !observed.finalDone) && !(r.outcome === "quarantined" && r.at !== undefined)) {
          if (observed?.valid === false) horizonCause = "clock-invalid";
          return { outcome: "error", failedSites: [], reason: `final-network observation horizon failed (cause=${horizonCause}, eligible=${observed?.finalDone === true}, closeObserved=${observed?.closes === 1}, baselineAnchors=${baseline?.anchors.length ?? 0}, replayAnchors=${observed?.anchors.length ?? 0}, sleeps=${horizonSleeps}, requiredMs=${Number.isFinite(horizonRequired) ? horizonRequired : "invalid"}, elapsedMs=${Number.isFinite(horizonElapsed) ? horizonElapsed : "invalid"})` };
        }
        const blocked = r.blockedWrites ?? [];
        const blockedFields = how.blockIndex === undefined ? {} : { blockedWrites: blocked.map((b) => `${b.method} ${b.path}`) };
        // #579: a select mutation found no other enabled live option — not applied, never proof.
        if (r.outcome === "quarantined" && /no-alternative/.test(r.reason)) {
          return { outcome: "not-applied", failedSites: [], ...blockedFields, reason: r.reason };
        }
        if (how.blockIndex !== undefined && !blockedOwnWrite(how.blockRequests ?? [], how.blockMatchers ?? [], blocked)) {
          return {
            outcome: "not-applied",
            failedSites: [],
            ...blockedFields,
            reason: `step ${m.step}'s own write was not blocked${(how.blockRequests ?? []).length === 0 ? "" : ` (recorded: ${(how.blockRequests ?? []).join(", ")})`}`,
          };
        }
        return {
          outcome: r.outcome === "quarantined" ? "failed" : "passed",
          failedSites: failedSitesOf(r, r.outcomeFailures ?? []),
          ...blockedFields,
          ...(r.outcome === "quarantined" ? { reason: r.reason } : {}),
        };
      } catch (err) {
        return { outcome: "error", failedSites: [], reason: err instanceof Error ? err.message : String(err) };
      }
    };
    // #402: a named mutation lowers to its `MutationReplay`; #609's targeted proof passes one directly.
    // A skipped step may be all that gave an earlier step's timer time to send the final check's request.
    // Its replay gets the base's time before that check is judged, so a late request is not read as a missing one.
    const judgesRequest = (m: JourneyMutation): boolean => m.kind === "skip" && plan.pairs.some((p) => {
      const site = p.mutation === m.id ? siteByKey.get(p.site) : undefined;
      return site?.where === "end-state" && (site.check.kind === "requestMade" || site.check.kind === "responseStatus");
    });
    const holdFor = (m: JourneyMutation): boolean => judgesRequest(m);
    const replay = (m: JourneyMutation, describe: typeof mutationReplay): Promise<Replayed> => runReplay(m, (j) => describe(j, m, replayOpts), holdFor(m));
    const siteByKey = new Map(sites.map((s) => [assertionSiteKey(s), s]));
    for (const m of plan.mutations) {
      const first = await replay(m, mutationReplay);
      // #554: a first failure at the mutated step's own postcondition hides the LATER paired sites
      // behind it; one relaxed replay (same action, the step's own expect/waitFor left out) judges them.
      const relaxed = needsRelaxedReplay(plan, m, first) ? await replay(m, relaxedMutationReplay) : undefined;
      const initial: MutationRunResult = { outcome: first.outcome, failedSites: first.failedSites, ...(relaxed === undefined ? {} : { relaxed }) };
      // #609: a later assertion still a `cascade` is only hidden by an earlier postcondition; a
      // targeted proof relaxes them one at a time (in a clone) to reach the target itself.
      const targeted: TargetedProof[] = [];
      for (const pair of plan.pairs) {
        if (pair.mutation !== m.id) continue;
        const site = siteByKey.get(pair.site);
        if (site === undefined || classifyMutation(site, m, initial) !== "cascade") continue;
        // #616: a declared plan (reviewed earlier relaxations) replaces the automatic bound search.
        const declared = declaredTargetedProofFor(journey, m, pair.site);
        targeted.push(
          declared === undefined
            ? await runTargetedProof(journey, plan, m, site, initial, (describe) => runReplay(m, describe, holdFor(m)), replayOpts)
            : await runDeclaredTargetedProof(journey, plan, m, site, declared, (describe) => runReplay(m, describe, holdFor(m)), replayOpts),
        );
        // #616: a proof the automatic bound stopped names the plan a human could declare instead.
        const suggestion = suggestTargetedProofPlan(targeted[targeted.length - 1]!, m);
        if (suggestion !== null) {
          const key = `${suggestion.check}\u0000${suggestion.mustFailWhen}\u0000${suggestion.relax.join(",")}`;
          if (!seenSuggestions.has(key)) {
            seenSuggestions.add(key);
            suggested.push(suggestion);
          }
        }
      }
      mutations.push({
        kind: m.kind,
        step: m.step,
        id: m.id,
        ...(m.param === undefined ? {} : { param: m.param }),
        ...(m.source === undefined ? {} : { source: m.source }),
        ...first,
        ...(relaxed === undefined ? {} : { relaxed }),
        ...(targeted.length === 0 ? {} : { targeted }),
      });
    }
  }

  const results = new Map<string, MutationRunResult>(
    mutations.map((m) => [
      m.id,
      { outcome: m.outcome, failedSites: m.failedSites, ...(m.relaxed === undefined ? {} : { relaxed: m.relaxed }), ...(m.targeted === undefined ? {} : { targeted: m.targeted }) },
    ]),
  );
  // Base failed: nothing ran, so every paired assertion is an `error` (no proof either way).
  const judged = judgeAssertions(journey, plan, results);
  const assertions: JourneyVerifyAssertion[] = judged.map((a) => ({
    site: a.site,
    check: checkOf.get(a.site) ?? a.site,
    verdict: a.verdict,
    ...(a.provedBy === undefined ? {} : { provedBy: a.provedBy }),
    ...(a.relaxedSites === undefined ? {} : { relaxedSites: a.relaxedSites }),
    ...(a.targetedRefusal === undefined ? {} : { targetedRefusal: a.targetedRefusal }),
    // #616: the proving proof was a declared plan, not the automatic relaxation search.
    ...(a.provedBy !== undefined && results.get(a.provedBy)?.targeted?.some((t) => t.site === a.site && t.declared === true) === true ? { declaredProof: true as const } : {}),
    ...(a.obligations === undefined ? {} : { obligations: a.obligations.map((o) => ({
      ...o,
      ...(o.provedBy !== undefined && results.get(o.provedBy)?.targeted?.some((t) => t.site === a.site && t.declared === true) === true ? { declaredProof: true as const } : {}),
    })) }),
  }));
  const order = new Map(journeyAssertions(journey).map((s, i) => [assertionSiteKey(s), i]));
  const siteOrder = (key: string): number => order.get(key) ?? Number.MAX_SAFE_INTEGER;
  const { verdict, reason } = mutationProofVerdict({ basePassed: base.outcome === "ok", mutations, assertions: judged });
  const count = (v: AssertionVerdict): number => assertions.filter((a) => a.verdict === v).length;
  const report: JourneyVerifyReport = {
    journeyId: journey.metadata.id,
    journeyHash,
    executionIdentity,
    base: baseFields,
    verdict,
    ...(reason === undefined ? {} : { reason }),
    mutations,
    assertions,
    summary: {
      sensitive: count("sensitive"),
      insensitive: count("insensitive"),
      cascade: count("cascade"),
      notApplied: count("not-applied"),
      error: count("error"),
      unpaired: count("unpaired"),
      // #609: assertions proven sensitive through a targeted proof that relaxed earlier sites.
      targeted: assertions.filter((a) => (a.relaxedSites?.length ?? 0) > 0).length,
    },
    // #616: in assertion order, so the first suggestion is the one for the refusal the verdict quotes.
    ...(suggested.length === 0 ? {} : { suggestedTargetedProofs: [...suggested].sort((a, b) => siteOrder(a.check) - siteOrder(b.check)) }),
  };
  // Reasons and check texts can quote what the page showed: a secret parameter never comes back.
  // Native digest/id contain no parameter values. Do not corrupt their typed identity if a
  // secret value happens to be a substring of a digest or protocol discriminant.
  const { executionIdentity: identity, ...redactable } = report;
  const redacted = { ...redactSecretParams(redactable, journey, opts.params), executionIdentity: identity };
  // #432: the verdict is kept beside the Journey (bound to its review hash) for `journey review`.
  await writePreflightedVerifyRecord(receiptDestination, {
    journeyId: journey.metadata.id,
    contentHash: journeyReviewHash(journey),
    proofHash: executionIdentity.proofHash,
    ...(proofContext === undefined ? {} : { proofContext }),
    verdict: redacted.verdict,
    ...(redacted.reason === undefined ? {} : { reason: redacted.reason }),
    summary: { ...redacted.summary },
    ...(redacted.suggestedTargetedProofs === undefined ? {} : { suggestedTargetedProofs: redacted.suggestedTargetedProofs }),
    at: clock.nowIso(),
  });
  return redacted;
}

/** One human line per assertion — verdict, site, check, and the mutation that proved it. */
export function verifyAssertionLine(a: JourneyVerifyAssertion): string {
  // #609: a sensitive verdict reached by a targeted proof names the earlier postconditions it relaxed.
  // #616: a declared plan's relaxations are named as reviewed, not as an automatic search.
  const relaxed =
    a.relaxedSites === undefined || a.relaxedSites.length === 0 ? "" : a.declaredProof === true ? `, declared plan relaxed ${a.relaxedSites.join(", ")}` : `, relaxed ${a.relaxedSites.join(", ")}`;
  const proved = a.provedBy === undefined ? "" : `  (proved by ${a.provedBy}${relaxed})`;
  const refused = a.targetedRefusal === undefined ? "" : `  (targeted proof refused: ${a.targetedRefusal})`;
  const obligations = a.obligations === undefined ? "" : `  [${a.obligations.map((o) => {
    const witness = o.provedBy === undefined ? "" : ` by ${o.provedBy}`;
    const relaxed = o.relaxedSites === undefined || o.relaxedSites.length === 0 ? "" : `, ${o.declaredProof === true ? "declared plan " : ""}relaxed ${o.relaxedSites.join(", ")}`;
    const refusal = o.targetedRefusal === undefined ? "" : `, targeted proof refused: ${o.targetedRefusal}`;
    return `${o.kind}: ${o.verdict}${witness}${relaxed}${refusal}`;
  }).join("; ")}]`;
  return `${a.verdict.padEnd(11)}  ${a.site.padEnd(18)}  ${a.check}${proved}${refused}${obligations}`;
}
