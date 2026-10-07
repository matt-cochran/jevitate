/**
 * #402 — `journey verify --mutate`: a built-in negative proof that each of a Journey's assertions
 * FAILS when its outcome is absent. The Journey is replayed once as recorded (it must pass), then
 * once per mutation (`planJourneyMutations`: skip a write step, abort its writes, or type an empty
 * value into a checked fill); each assertion is sensitive only when its paired mutation broke it, at
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
  journeyAssertions,
  judgeAssertions,
  mutationProofVerdict,
  mutationReplay,
  planJourneyMutations,
  type AssertionVerdict,
  type JourneyMutation,
  type MutationFailedSite,
  type MutationProofVerdict,
  type MutationRunResult,
} from "@jevitate/journey";
import { describeCheck, type BlockedWrite } from "@jevitate/explore";
import { journeyContentHash } from "./journey-annotate-api.js";
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
  readonly outcome: MutationRunResult["outcome"];
  readonly failedSites: readonly MutationFailedSite[];
  /** block-write: what was aborted (`METHOD path`). */
  readonly blockedWrites?: readonly string[];
  /** Why the replay failed, was not applied, or errored. */
  readonly reason?: string;
}

export interface JourneyVerifyAssertion {
  readonly site: string;
  /** The assertion, in the `--success` spec syntax. */
  readonly check: string;
  readonly verdict: AssertionVerdict;
  readonly provedBy?: string;
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
  readonly summary: Readonly<Record<"sensitive" | "insensitive" | "cascade" | "notApplied" | "error" | "unpaired", number>>;
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
  if (result.at !== undefined) return [{ where: "step", step: result.at + 1, postcondition: /postcondition failed/.test(result.reason ?? "") }];
  return failures.map((f): MutationFailedSite =>
    f.where === "step-request" ? { where: "step-request", step: f.step, checkIndex: f.checkIndex } : f.where === "end-state" ? { where: "end-state", index: f.index } : { where: "unevaluable" },
  );
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
  if (base.outcome === "ok") {
    for (const m of plan.mutations) {
      const how = mutationReplay(journey, m, lintOpts);
      const fields = { kind: m.kind, step: m.step, id: m.id };
      try {
        const r = await run(runOpts, {
          structuredFailures: true,
          ...(how.journey === journey ? {} : { mutateJourney: (j) => mutationReplay(j, m, lintOpts).journey }),
          ...(how.skipIndex === undefined ? {} : { skipStep: (i: number) => i === how.skipIndex }),
          ...(how.blockIndex === undefined ? {} : { blockWritesAtStep: how.blockIndex }),
        });
        const blocked = r.blockedWrites ?? [];
        const blockedFields = how.blockIndex === undefined ? {} : { blockedWrites: blocked.map((b) => `${b.method} ${b.path}`) };
        if (how.blockIndex !== undefined && !blockedOwnWrite(how.blockRequests ?? [], blocked)) {
          mutations.push({
            ...fields,
            outcome: "not-applied",
            failedSites: [],
            ...blockedFields,
            reason: `step ${m.step}'s own write was not blocked${(how.blockRequests ?? []).length === 0 ? "" : ` (recorded: ${(how.blockRequests ?? []).join(", ")})`}`,
          });
          continue;
        }
        const failedSites = failedSitesOf(r, r.outcomeFailures ?? []);
        mutations.push({
          ...fields,
          outcome: r.outcome === "quarantined" ? "failed" : "passed",
          failedSites,
          ...blockedFields,
          ...(r.outcome === "quarantined" ? { reason: r.reason } : {}),
        });
      } catch (err) {
        mutations.push({ ...fields, outcome: "error", failedSites: [], reason: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  const results = new Map<string, MutationRunResult>(mutations.map((m) => [m.id, { outcome: m.outcome, failedSites: m.failedSites }]));
  // Base failed: nothing ran, so every paired assertion is an `error` (no proof either way).
  const judged = judgeAssertions(journey, plan, results);
  const assertions: JourneyVerifyAssertion[] = judged.map((a) => ({ site: a.site, check: checkOf.get(a.site) ?? a.site, verdict: a.verdict, ...(a.provedBy === undefined ? {} : { provedBy: a.provedBy }) }));
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
    },
  };
  // Reasons and check texts can quote what the page showed: a secret parameter never comes back.
  return redactSecretParams(report, journey, opts.params);
}

/** One human line per assertion — verdict, site, check, and the mutation that proved it. */
export function verifyAssertionLine(a: JourneyVerifyAssertion): string {
  return `${a.verdict.padEnd(11)}  ${a.site.padEnd(18)}  ${a.check}${a.provedBy === undefined ? "" : `  (proved by ${a.provedBy})`}`;
}
