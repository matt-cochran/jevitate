/**
 * #812: the gatherer's half of `journey verify --mutate` (docs/design/0.30.0-evidence-and-trust.md §2,
 * §4). A proof's replays become `MutationEvidence`, replay by replay, and the verdict is
 * `adjudicate()`'s: nothing here judges. What each replay is for (its role, its mutation, the site a
 * targeted proof aims at), how it ended and where it failed, the sites a control struck from it
 * (`waitsCut`), whether a checkpoint supplied it (`reused`), and how many writes it left open at its
 * close are facts the proof established while it ran; the rules that read them live in
 * @jevitate/adjudicator.
 *
 * Replays are listed per mutation in one canonical order, so a reader (and the adjudicator) can tell
 * which replay answers for which: base, the independence replays, then for each pair its mutated
 * replay, that replay at the base's time, its relaxed replay and that one at the base's time, each
 * targeted proof and its control, the pair's control, its re-run; the closing replay last. Ordinals
 * count that order, not the order the browser ran them in. A control that sibling mutations shared
 * is listed under each mutation that read it.
 *
 * Value-free: outcomes, site keys, mutation ids, counts and code-templated refusals. A replay's own
 * error text can quote the page, so it is never copied: a retry is recorded as the fact that one ran.
 */
import {
  type IsolationNote,
  type Known,
  type MutationEvidence,
  type ReplayEvidence,
  type RunEvidence,
  type WritesEvidence,
} from "@jevitate/adjudicator";
import { clock } from "@jevitate/domain";
import { mutationPlanSites, type Journey, type MutationFailedSite, type MutationPlan, type MutationRunResult, type TargetedProof } from "@jevitate/journey";
import { currentEngineInfo, type EngineInfo } from "./engine.js";

/** One replay a pair ran, as it ran: its kind, how it ended, and the writes it left open that the proof counts. */
export interface LedgerReplay {
  readonly role: ReplayEvidence["role"];
  /** The mutation it ran under, or answered for (a control); absent on the base, independence and closing replays. */
  readonly mutation?: string;
  readonly outcome: MutationRunResult["outcome"];
  /**
   * Writes still open at the replay's close that the proof counts: in its write scope, and not a
   * long-lived line the base and the independence replay both kept open. Unknown when nothing watched.
   */
  readonly openAtClose: Known<number>;
}

/** A finished pair, in the report's shape (`JourneyVerifyMutation`): what the evidence reads of it. */
export interface GatheredPair extends MutationRunResult {
  readonly id: string;
  readonly reused?: true;
  readonly retries?: readonly { readonly reason: string }[];
}

/** Everything a proof gathered, at the moment its evidence is read. */
export interface ProofGathering {
  readonly journey: Journey;
  readonly plan: MutationPlan;
  readonly basePassed: boolean;
  /** The base's own writes left open that the proof counted (a write it recorded, or one the independence replay did not also keep open). */
  readonly baseOpenAtClose: number;
  /** The independence replays (as recorded, after the base), and the pairs' replays, in the order they ran. */
  readonly ledger: readonly LedgerReplay[];
  /** The independence replays' reading; unknown when it errored or never ran. */
  readonly isolation: MutationEvidence["isolation"];
  readonly pairs: readonly GatheredPair[];
  readonly restore: MutationEvidence["restore"];
  /** The first finding that a replay may have decided another, as the proof noted it. */
  readonly taint?: { readonly note: IsolationNote; readonly by?: string; readonly carried?: true };
  /** How the closing replay as recorded ended, when it ran. */
  readonly closing?: "passed" | "failed" | "error";
}

/** The run's context: where it ran, and its parameters as a keyed digest. Never a value. */
export interface ProofEvidenceContext {
  readonly origin: string;
  readonly environment?: string | undefined;
  readonly channel: RunEvidence["run"]["channel"];
  readonly paramsDigest: string;
  readonly secretParamNames: readonly string[];
  readonly engine?: EngineInfo;
}

const NOT_GATHERED = { known: false, reason: "not-gathered" } as const;
const known = (value: number): Known<number> => ({ known: true, value });
/** A retry's own error can quote the page, so the record says only that one ran (#778). */
const RETRIED = "the replay errored before it opened a browser, and ran once more";

function writesOf(openAtClose: Known<number>): WritesEvidence {
  return { sent: NOT_GATHERED, answered: NOT_GATHERED, aborted: NOT_GATHERED, openAtClose, shapes: [] };
}

/** Two counts, summed; unknown when either is. */
function add(a: Known<number>, b: Known<number>): Known<number> {
  if (!a.known) return a;
  if (!b.known) return b;
  return known(a.value + b.value);
}

function failedSitesOf(sites: readonly MutationFailedSite[]): ReplayEvidence["failedSites"] {
  return sites.map((f): ReplayEvidence["failedSites"][number] => {
    if (f.where === "step") return { where: "step", step: f.step, postcondition: f.postcondition };
    if (f.where === "step-request") return { where: "step-request", step: f.step, checkIndex: f.checkIndex, ...(f.evaluated === true ? { evaluated: true as const } : {}) };
    if (f.where === "end-state") return { where: "end-state", index: f.index };
    return { where: "unevaluable" };
  });
}

const cutOf = (waitsCut: readonly string[] | undefined): { waitsCut?: string[] } => (waitsCut === undefined || waitsCut.length === 0 ? {} : { waitsCut: [...waitsCut] });

type Draft = Omit<ReplayEvidence, "ordinal" | "writes">;

/** One pair's replays, in canonical order, without their writes. */
function pairDrafts(pair: GatheredPair): Draft[] {
  const mutation = pair.id;
  const reused = pair.reused === true ? { reused: true as const } : {};
  const drafts: Draft[] = [
    {
      role: "mutated",
      mutation,
      outcome: pair.outcome,
      failedSites: failedSitesOf(pair.failedSites),
      ...cutOf(pair.waitsCut),
      ...reused,
      ...(pair.retries === undefined || pair.retries.length === 0 ? {} : { retries: pair.retries.map(() => ({ reason: RETRIED })) }),
    },
  ];
  if (pair.atBaseTime !== undefined) drafts.push({ role: "at-base-time", mutation, outcome: pair.atBaseTime.outcome, failedSites: failedSitesOf(pair.atBaseTime.failedSites), ...reused });
  if (pair.relaxed !== undefined) {
    drafts.push({ role: "relaxed", mutation, outcome: pair.relaxed.outcome, failedSites: failedSitesOf(pair.relaxed.failedSites), ...cutOf(pair.relaxed.waitsCut), ...reused });
    const timed = pair.relaxed.atBaseTime;
    if (timed !== undefined) drafts.push({ role: "at-base-time", mutation, outcome: timed.outcome, failedSites: failedSitesOf(timed.failedSites), ...reused });
  }
  for (const proof of pair.targeted ?? []) drafts.push(...targetedDrafts(mutation, proof, reused));
  if (pair.control !== undefined) drafts.push({ role: "control", mutation, outcome: pair.control, failedSites: [], ...reused });
  if (pair.rerun !== undefined) drafts.push({ role: "rerun", mutation, outcome: pair.rerun, failedSites: [], ...reused });
  return drafts;
}

/** A targeted proof's final replay (a refused attempt may have run none) and its control. */
function targetedDrafts(mutation: string, proof: TargetedProof, reused: { reused?: true }): Draft[] {
  const run: Draft = {
    role: "targeted",
    mutation,
    site: proof.site,
    relaxedSites: [...proof.relaxedSites],
    outcome: proof.outcome,
    failedSites: failedSitesOf(proof.failedSites),
    ...(proof.refused === undefined ? {} : { refused: proof.refused }),
    ...reused,
  };
  return proof.control === undefined ? [run] : [run, { role: "control", mutation, site: proof.site, outcome: proof.control, failedSites: [], ...reused }];
}

/**
 * Each pair replay's open writes, from the ledger: a role's count goes on the first replay of that role
 * listed for the pair, and a count the listing has no replay for goes on the pair's mutated replay, so no
 * open write the proof saw is left out. A replay a checkpoint supplied finished untainted: none open.
 */
function withWrites(pair: GatheredPair, drafts: readonly Draft[], ledger: readonly LedgerReplay[]): { draft: Draft; open: Known<number> }[] {
  const out = drafts.map((draft) => ({ draft, open: known(0) as Known<number> }));
  if (pair.reused === true) return out;
  const byRole = new Map<ReplayEvidence["role"], Known<number>>();
  for (const r of ledger) if (r.mutation === pair.id && r.role !== "independence") byRole.set(r.role, add(byRole.get(r.role) ?? known(0), r.openAtClose));
  for (const [role, open] of byRole) {
    const first = out.find((o) => o.draft.role === role) ?? out[0]!;
    first.open = add(first.open, open);
  }
  return out;
}

/** The proof's `MutationEvidence`, replay by replay. */
export function mutationEvidenceOf(g: ProofGathering): MutationEvidence {
  const replays: ReplayEvidence[] = [];
  const push = (draft: Draft, open: Known<number>): void => void replays.push({ ordinal: replays.length, ...draft, writes: writesOf(open) });
  push({ role: "base", outcome: g.basePassed ? "passed" : "failed", failedSites: [] }, known(g.baseOpenAtClose));
  for (const r of g.ledger) if (r.role === "independence") push({ role: "independence", outcome: r.outcome, failedSites: [] }, r.openAtClose);
  for (const pair of g.pairs) for (const { draft, open } of withWrites(pair, pairDrafts(pair), g.ledger)) push(draft, open);
  // Nothing runs after the closing replay and nothing watches its writes.
  if (g.closing !== undefined) push({ role: "closing", outcome: g.closing, failedSites: [] }, NOT_GATHERED);
  return {
    plan: {
      mutations: g.plan.mutations.map((m) => ({ id: m.id, kind: m.kind, step: m.step, ...(m.param === undefined ? {} : { param: m.param }) })),
      pairs: g.plan.pairs.map((p) => ({ site: p.site, mutation: p.mutation, ...(p.declared === true ? { declared: true as const } : {}) })),
      sites: mutationPlanSites(g.journey).map((s) => ({ site: s.site, check: s.check, ...(s.required === true ? { required: true as const } : {}) })),
    },
    replays,
    restore: g.restore,
    isolation: g.isolation,
    ...(g.taint === undefined ? {} : { taint: { note: g.taint.note, ...(g.taint.by === undefined ? {} : { by: g.taint.by }), ...(g.taint.carried === true ? { carried: true as const } : {}) } }),
  };
}

/** The whole proof as one `RunEvidence` record (subject `mutation-proof`), the adjudicator's only input. */
export function proofEvidenceOf(g: ProofGathering, journeyHash: string, ctx: ProofEvidenceContext): RunEvidence {
  const mutation = mutationEvidenceOf(g);
  const open = mutation.replays.filter((r) => r.role !== "closing").reduce<Known<number>>((sum, r) => add(sum, r.writes.openAtClose), known(0));
  const engine = ctx.engine ?? currentEngineInfo();
  let origin = ctx.origin;
  try {
    origin = new URL(ctx.origin).origin;
  } catch {
    // Kept as given: the record's schema refuses it when it is written, and nothing judges it.
  }
  return {
    schema: "jevitate.evidence",
    version: 1,
    producedAt: clock.nowIso(),
    producer: { jevitate: engine.version.slice(0, 64), commit: engine.commit.slice(0, 64) },
    subject: { kind: "mutation-proof", journey: { id: g.journey.metadata.id, hash: journeyHash } },
    run: {
      // §5: decided by target configuration once d-run-modes reaches the proof; until then a proof's target is unknown.
      mode: "automation",
      channel: ctx.channel,
      target: { origin, ...(ctx.environment === undefined ? {} : { environment: ctx.environment }), trust: "unknown" },
      paramsDigest: ctx.paramsDigest,
      secretParamNames: [...new Set(ctx.secretParamNames)].sort(),
    },
    steps: [],
    writes: writesOf(open),
    mutation,
    judgments: [],
    notes: [],
  };
}
