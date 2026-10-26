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
  journeyProofHash,
  judgeAssertions,
  mutationProofVerdict,
  mutationReplay,
  needsRelaxedReplay,
  planJourneyMutations,
  relaxedMutationReplay,
  runDeclaredTargetedProof,
  runTargetedProof,
  suggestTargetedProofPlan,
  type AssertionVerdict,
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
import { writeVerifyRecord } from "./journey-review-store.js";
import { UnknownJourneyError, redactSecretParams, runJourneyProgrammatically, type RunJourneyProgrammaticallyOptions } from "./journey-api.js";
import type { OutcomeCheckFailure } from "./journey-network-checks.js";

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
}

export interface JourneyVerifyReport {
  readonly journeyId: string;
  /** `journeyContentHash` of the stored Journey: the proof is bound to exactly this content. */
  readonly journeyHash: string;
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
  readonly mutations: readonly Pick<JourneyMutation, "kind" | "step" | "id" | "param" | "source">[];
  readonly pairs: readonly { readonly site: string; readonly check: string; readonly mutation: string; readonly declared?: true }[];
  readonly assertions: readonly { readonly site: string; readonly check: string; readonly mutations: readonly string[] }[];
  readonly summary: Readonly<Record<"mutations" | "pairs" | "assertions" | "unpaired" | "minimumReplays", number>>;
}

/**
 * Static preview of `journey verify --mutate`: no browser, fixtures, hooks, target, session or
 * credential is opened. Values of params are used only to derive the plan and are never returned.
 */
export async function planJourneyVerification(
  opts: Pick<VerifyJourneyOptions, "dir" | "id" | "params" | "readRequests">,
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

function pathOf(p: string): string {
  try {
    return /^https?:\/\//i.test(p) ? new URL(p).pathname : p.split("?")[0]!;
  } catch {
    return p;
  }
}

/** Was the step's own recorded write among the blocked? With no recorded request, any blocked write counts. */
function blockedOwnWrite(recorded: readonly string[], blocked: readonly BlockedWrite[]): boolean {
  if (recorded.length === 0) return blocked.length > 0;
  return recorded.some((line) => {
    const m = REQUEST_LINE.exec(line.trim());
    if (m === null) return false;
    return blocked.some((b) => b.method.toUpperCase() === m[1]!.toUpperCase() && pathOf(b.path) === pathOf(m[2]!));
  });
}

function failedSitesOf(result: { outcome: string; reason?: string; at?: number }, failures: readonly OutcomeCheckFailure[]): MutationFailedSite[] {
  if (result.outcome !== "quarantined") return [];
  const structured = failures.map((f): MutationFailedSite =>
    f.where === "step-request" ? { where: "step-request", step: f.step, checkIndex: f.checkIndex } : f.where === "end-state" ? { where: "end-state", index: f.index } : { where: "unevaluable" },
  );
  return result.at === undefined ? structured : [...structured, { where: "step", step: result.at + 1, postcondition: /postcondition failed/.test(result.reason ?? "") }];
}

/**
 * Runs the proof for one Journey by id. Usage errors (unknown id, bad params, an environment that
 * refuses a step, a site-gate refusal) throw exactly as `journey run`'s do, before any mutation.
 */
export async function verifyJourneyMutations(opts: VerifyJourneyOptions, run: Run = runJourneyProgrammatically): Promise<JourneyVerifyReport> {
  const journey = await new JourneyRegistry(new FsJourneyStore(opts.dir)).get(opts.id);
  if (!journey) throw new UnknownJourneyError(`unknown journey '${opts.id}'`);
  const { readRequests, ...runOpts } = opts;
  const lintOpts = readRequests === undefined ? {} : { readRequests };
  const journeyHash = journeyContentHash(journey);

  const base = await run(runOpts, { structuredFailures: true });
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
    const runReplay = async (m: JourneyMutation, describe: (j: Journey) => MutationReplay): Promise<Replayed> => {
      try {
        const how = describe(journey);
        const r = await run(how.params === undefined ? runOpts : { ...runOpts, params: { ...how.params } }, {
          structuredFailures: true,
          ...(how.journey === journey ? {} : { mutateJourney: (j) => describe(j).journey }),
          ...(how.skipIndex === undefined ? {} : { skipStep: (i: number) => i === how.skipIndex }),
          ...(how.swapSelectAtStep === undefined ? {} : { selectAlternativeAtStep: how.swapSelectAtStep }),
          ...(how.blockIndex === undefined ? {} : { blockWritesAtStep: how.blockIndex }),
        });
        const blocked = r.blockedWrites ?? [];
        const blockedFields = how.blockIndex === undefined ? {} : { blockedWrites: blocked.map((b) => `${b.method} ${b.path}`) };
        // #579: a select mutation found no other enabled live option — not applied, never proof.
        if (r.outcome === "quarantined" && /no-alternative/.test(r.reason)) {
          return { outcome: "not-applied", failedSites: [], ...blockedFields, reason: r.reason };
        }
        if (how.blockIndex !== undefined && !blockedOwnWrite(how.blockRequests ?? [], blocked)) {
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
    const replay = (m: JourneyMutation, describe: typeof mutationReplay): Promise<Replayed> => runReplay(m, (j) => describe(j, m, replayOpts));
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
            ? await runTargetedProof(journey, plan, m, site, initial, (describe) => runReplay(m, describe), replayOpts)
            : await runDeclaredTargetedProof(journey, plan, m, site, declared, (describe) => runReplay(m, describe), replayOpts),
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
  }));
  const order = new Map(journeyAssertions(journey).map((s, i) => [assertionSiteKey(s), i]));
  const siteOrder = (key: string): number => order.get(key) ?? Number.MAX_SAFE_INTEGER;
  const { verdict, reason } = mutationProofVerdict({ basePassed: base.outcome === "ok", mutations, assertions: judged });
  const count = (v: AssertionVerdict): number => assertions.filter((a) => a.verdict === v).length;
  const report: JourneyVerifyReport = {
    journeyId: journey.metadata.id,
    journeyHash,
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
  const redacted = redactSecretParams(report, journey, opts.params);
  // #432: the verdict is kept beside the Journey (bound to its review hash) for `journey review`.
  await writeVerifyRecord(opts.dir, {
    journeyId: journey.metadata.id,
    contentHash: journeyReviewHash(journey),
    proofHash: journeyProofHash(journey),
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
  return `${a.verdict.padEnd(11)}  ${a.site.padEnd(18)}  ${a.check}${proved}${refused}`;
}
