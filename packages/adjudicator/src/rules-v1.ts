/**
 * Rules v1 (docs/design/0.30.0-evidence-and-trust.md §3.1, §4, §5.1-5.2, §6): what a `RunEvidence`
 * record means. Pure: no I/O, no clock, no model; it reads the record and nothing else.
 *
 * The mutation-proof rules (`classifyMutation`, `classifyMutationPlain`, `provenSensitive`,
 * `judgeAssertions`, `mutationProofVerdict`) are COPIED from packages/journey/src/mutation-proof.ts
 * as of 0.29.0, which keeps its own copies until the gatherer move. Two changes, neither moving a
 * verdict: they judge the evidence's plan sites (parsed site keys) instead of a `Journey`, and the
 * proof's verdict word is `sensitive`, not `proven` (§6.1). The reason strings are kept as they were.
 *
 * PR #811 (not landed when this was written) changes this logic: UI effects get `skip` only, request
 * checks pair with their unique originating step, an own-request failure is kept when the DOM
 * postcondition also fails, and sites gain `required` / failures `evaluated`. When #811 lands, these
 * functions must be re-ported from its mutation-proof.ts; the v1 rule set is the one #811 leaves.
 */
import type {
  BoundaryEvidence,
  DoneCheckEvidence,
  DoneReading,
  MutationEvidence,
  MutationKindSchema,
  ReplayEvidence,
  RunEvidence,
} from "./evidence.js";
import type { z } from "zod";
import type { AssertionResult, AssertionVerdict, BoundaryVerdict, ChecksVerdict, JobVerdict, MutationVerdict, Verdict } from "./verdict.js";

// ---------------------------------------------------------------------------------------------
// The shapes the ported rules read, rebuilt from the evidence (journey's types, minus the Journey).
// ---------------------------------------------------------------------------------------------

/** An assertion site as its key names it: `step:<n>` · `step-request:<n>:<i>` · `end-state:<i>`. */
export type AssertionSite =
  | { readonly where: "step"; readonly step: number }
  | { readonly where: "step-request"; readonly step: number; readonly checkIndex: number }
  | { readonly where: "end-state"; readonly index: number };

/** Where a mutated replay failed. `postcondition`: the step's own assertion failed (not its action). */
export type MutationFailedSite =
  | { readonly where: "step"; readonly step: number; readonly postcondition: boolean }
  | { readonly where: "step-request"; readonly step: number; readonly checkIndex: number }
  | { readonly where: "end-state"; readonly index: number }
  | { readonly where: "unevaluable" };

export interface PlannedMutation {
  readonly id: string;
  readonly kind: z.infer<typeof MutationKindSchema>;
  readonly step: number;
  readonly param?: string;
}

export interface MutationPlan {
  readonly mutations: readonly PlannedMutation[];
  readonly pairs: readonly { readonly site: string; readonly mutation: string; readonly declared?: true }[];
}

export type RunOutcome = "passed" | "failed" | "not-applied" | "error";

export interface BaseTimedRun {
  readonly outcome: RunOutcome;
  readonly failedSites: readonly MutationFailedSite[];
}

export interface TargetedProof {
  readonly site: string;
  readonly relaxedSites: readonly string[];
  readonly outcome: RunOutcome;
  readonly failedSites: readonly MutationFailedSite[];
  readonly refused?: string;
  readonly control?: RunOutcome;
}

export interface MutationRunResult {
  readonly outcome: RunOutcome;
  readonly failedSites: readonly MutationFailedSite[];
  readonly waitsCut?: readonly string[];
  readonly relaxed?: { readonly outcome: RunOutcome; readonly failedSites: readonly MutationFailedSite[]; readonly waitsCut?: readonly string[]; readonly atBaseTime?: BaseTimedRun };
  readonly targeted?: readonly TargetedProof[];
  readonly control?: RunOutcome;
  readonly atBaseTime?: BaseTimedRun;
  readonly rerun?: RunOutcome;
}

/** `AssertionResult` plus why a targeted proof was refused; the refusal feeds the proof's reason only. */
export interface AssertionProof extends AssertionResult {
  readonly targetedRefusal?: string;
}

export type MutationProofVerdict = "sensitive" | "insensitive" | "inconclusive";

export function assertionSiteKey(site: AssertionSite): string {
  if (site.where === "step") return `step:${site.step}`;
  if (site.where === "step-request") return `step-request:${site.step}:${site.checkIndex}`;
  return `end-state:${site.index}`;
}

const SITE_KEY = /^(?:step:([1-9][0-9]*)|step-request:([1-9][0-9]*):(0|[1-9][0-9]*)|end-state:(0|[1-9][0-9]*))$/;

/** The site a key names, or undefined when it names none. */
export function parseSiteKey(key: string): AssertionSite | undefined {
  const m = SITE_KEY.exec(key);
  if (m === null) return undefined;
  if (m[1] !== undefined) return { where: "step", step: Number(m[1]) };
  if (m[2] !== undefined) return { where: "step-request", step: Number(m[2]), checkIndex: Number(m[3]) };
  return { where: "end-state", index: Number(m[4]) };
}

// ---------------------------------------------------------------------------------------------
// Ported from packages/journey/src/mutation-proof.ts (0.29.0).
// ---------------------------------------------------------------------------------------------

/**
 * #609 — classify on the plain rules, then, when that is a `cascade` and `result.targeted` carries a
 * targeted proof for this site, classify on that proof's final run (no further relaxation). A
 * refused targeted attempt still cascades; a site is sensitive only when the target itself failed.
 */
export function classifyMutation(site: AssertionSite, m: PlannedMutation, result: MutationRunResult): MutationVerdict {
  const verdict = classifyMutationPlain(site, m, result);
  if (verdict !== "cascade") return verdict;
  const proof = result.targeted?.find((t) => t.site === assertionSiteKey(site));
  if (proof === undefined || proof.refused !== undefined) return "cascade";
  const targeted = classifyMutationPlain(site, m, { outcome: proof.outcome, failedSites: proof.failedSites });
  return targeted === "sensitive" || targeted === "insensitive" ? targeted : "cascade";
}

/**
 * #402: one assertion against one mutated replay. Sensitive only when the replay failed AT that
 * assertion and nothing failed before the mutated step — a failure anywhere else is a cascade,
 * never counted as proof.
 */
export function classifyMutationPlain(
  site: AssertionSite,
  m: PlannedMutation,
  result: Pick<MutationRunResult, "outcome" | "failedSites" | "waitsCut" | "relaxed" | "atBaseTime">,
): MutationVerdict {
  // #554: the mutated step's own postcondition failed, so a later site is judged on the relaxed
  // replay (same rules, no further relaxed level). The step's own step site keeps the original
  // result, so its own failure stays the sensitive verdict.
  if (
    result.relaxed !== undefined &&
    result.failedSites.some((f) => f.where === "step" && f.step === m.step && f.postcondition) &&
    !(site.where === "step" && site.step === m.step)
  ) {
    return classifyMutationPlain(site, m, result.relaxed);
  }
  const verdict = classifyFailure(site, m, result);
  if (verdict !== "sensitive" || (result.waitsCut?.length ?? 0) === 0) return verdict;
  // No control's waiting matches this failure, so it is no evidence. Only a replay of the same
  // mutation that passed at the base's own time says the claim holds without it.
  return result.atBaseTime?.outcome === "passed" ? "insensitive" : "cascade";
}

/** Where the replay failed, against this site, before asking whether that failure is evidence. */
function classifyFailure(site: AssertionSite, m: PlannedMutation, result: Pick<MutationRunResult, "outcome" | "failedSites">): MutationVerdict {
  if (result.outcome === "passed") return "insensitive";
  if (result.outcome === "not-applied") return "not-applied";
  if (result.outcome === "error") return "error";
  const fs = result.failedSites;
  if (site.where === "step") {
    const hit = fs.some((f) => f.where === "step" && f.step === site.step && f.postcondition);
    return hit && site.step >= m.step ? "sensitive" : "cascade";
  }
  if (site.where === "step-request") {
    const hit = fs.some((f) => f.where === "step-request" && f.step === site.step && f.checkIndex === site.checkIndex);
    const earlierFailure = fs.some(
      (f) => f.where === "unevaluable" || (f.where === "step" && f.step <= site.step) || (f.where === "step-request" && f.step < m.step),
    );
    // A later action can fail because this mutation removed the state it needed. That cascade does
    // not erase an exact request-check failure already observed at the target step.
    return hit && site.step >= m.step && !earlierFailure ? "sensitive" : "cascade";
  }
  // A step failed (the outcome checks were never judged), or the end state could not be read.
  if (fs.some((f) => f.where === "step" || f.where === "unevaluable")) return "cascade";
  if (fs.some((f) => f.where === "step-request" && f.step < m.step)) return "cascade";
  return fs.some((f) => f.where === "end-state" && f.index === site.index) ? "sensitive" : "cascade";
}

const PRECEDENCE: readonly MutationVerdict[] = ["sensitive", "insensitive", "cascade", "not-applied", "error"];
const ERRORED: MutationRunResult = { outcome: "error", failedSites: [] };

/**
 * #616: is `key` proven sensitive to `m` — directly, or through a targeted proof whose own relaxed
 * sites are (recursively) proven sensitive to `m`? `visiting` breaks a relaxation cycle (unsound).
 */
export function provenSensitive(
  sites: readonly AssertionSite[],
  m: PlannedMutation,
  results: ReadonlyMap<string, MutationRunResult>,
  key: string,
  visiting: ReadonlySet<string>,
): boolean {
  if (visiting.has(key)) return false;
  const site = sites.find((s) => assertionSiteKey(s) === key);
  const result = results.get(m.id) ?? ERRORED;
  if (site === undefined || classifyMutation(site, m, result) !== "sensitive") return false;
  const proof = result.targeted?.find((t) => t.site === key);
  if (proof === undefined || proof.refused !== undefined) return true;
  const next = new Set([...visiting, key]);
  return proof.relaxedSites.every((relaxed) => provenSensitive(sites, m, results, relaxed, next));
}

/**
 * #402/#609: every assertion's verdict over its paired mutations — sensitive when ANY paired
 * mutation broke it for the right reason (`provedBy` the first), else insensitive when one passed,
 * else cascade / not-applied / error; `unpaired` when no mutation is paired with it. A sensitive
 * verdict reached by a targeted proof records its relaxed sites; a cascade that a targeted attempt
 * refused records why (#609).
 */
export function judgeAssertions(sites: readonly AssertionSite[], plan: MutationPlan, results: ReadonlyMap<string, MutationRunResult>): AssertionProof[] {
  const proofFor = (m: PlannedMutation, key: string): TargetedProof | undefined => results.get(m.id)?.targeted?.find((t) => t.site === key);
  return sites.map((site): AssertionProof => {
    const key = assertionSiteKey(site);
    const paired = plan.mutations.filter((m) => plan.pairs.some((p) => p.site === key && p.mutation === m.id));
    if (paired.length === 0) return { site: key, verdict: "unpaired" };
    const verdicts = paired.map((m) => ({ m, v: classifyMutation(site, m, results.get(m.id) ?? ERRORED) }));
    // #616: set when every sensitive verdict rested on an unproven relaxed site — those count as cascades.
    let unsound: string | undefined;
    for (const v of PRECEDENCE) {
      const first = verdicts.find((x) => x.v === v);
      if (first === undefined && !(v === "cascade" && unsound !== undefined)) continue;
      if (v === "sensitive") {
        for (const { m } of verdicts.filter((x) => x.v === "sensitive")) {
          const proof = proofFor(m, key);
          if (proof === undefined || proof.refused !== undefined) return { site: key, verdict: v, provedBy: m.id };
          const bad = proof.relaxedSites.find((relaxed) => !provenSensitive(sites, m, results, relaxed, new Set([key])));
          if (bad === undefined) return { site: key, verdict: v, provedBy: m.id, relaxedSites: proof.relaxedSites };
          unsound ??= `relaxed site ${bad} is not itself proven sensitive to ${m.id}`;
        }
        continue;
      }
      if (v === "cascade" && unsound !== undefined) return { site: key, verdict: v, targetedRefusal: unsound };
      if (v === "cascade") {
        const refusal = paired.map((m) => proofFor(m, key)).find((t) => t !== undefined && t.refused !== undefined);
        if (refusal !== undefined) return { site: key, verdict: v, targetedRefusal: refusal.refused! };
      }
      return { site: key, verdict: v };
    }
    return { site: key, verdict: "error" };
  });
}

type MutationOutcomes = Pick<MutationRunResult, "outcome"> & Partial<Pick<MutationRunResult, "relaxed" | "targeted" | "control" | "rerun" | "atBaseTime">>;

/** A replay of this mutation errored, so it leaves the proof a gap. A refused targeted proof carries `error` but ran no replay. */
export function mutationErrored(m: MutationOutcomes): boolean {
  return (
    m.outcome === "error" ||
    m.relaxed?.outcome === "error" ||
    m.control === "error" ||
    m.rerun === "error" ||
    m.atBaseTime?.outcome === "error" ||
    m.relaxed?.atBaseTime?.outcome === "error" ||
    (m.targeted ?? []).some((t) => (t.refused === undefined && t.outcome === "error") || t.control === "error")
  );
}

/**
 * #402: sensitive when every PAIRED assertion is sensitive; insensitive when any paired assertion
 * still passed under its mutation; inconclusive when a fixture restore failed or a replay left work
 * behind (this outranks everything), the unmutated replay failed, any mutated, relaxed or targeted
 * replay errored, nothing was paired, or what is left is only cascades / not-applied. An insensitive
 * assertion is a real finding and outranks an errored replay.
 */
export function mutationProofVerdict(input: {
  readonly basePassed: boolean;
  readonly mutations: readonly MutationOutcomes[];
  readonly assertions: readonly AssertionProof[];
  readonly restoreFailed?: boolean;
  readonly notIsolated?: string;
}): { readonly verdict: MutationProofVerdict; readonly reason?: string } {
  if (input.restoreFailed === true) return { verdict: "inconclusive", reason: "a fixture restore failed during the proof, so state it left behind may have decided a replay; fix the restore and run the proof again" };
  if (input.notIsolated !== undefined) return { verdict: "inconclusive", reason: input.notIsolated };
  if (!input.basePassed) return { verdict: "inconclusive", reason: "the unmutated replay failed — no mutation was run" };
  if (input.mutations.length > 0 && input.mutations.every((m) => m.outcome === "error")) {
    return { verdict: "inconclusive", reason: "every mutated replay errored" };
  }
  const paired = input.assertions.filter((a) => a.verdict !== "unpaired");
  if (paired.length === 0) return { verdict: "inconclusive", reason: "no assertion is paired with a mutation (no write step, no checked fill, no checked parameter, no mutationPairs). A parameter treated as secret gets no mutation, and a name that reads as a credential counts as one unless it declares secret: false and a person approved the Journey" };
  if (paired.some((a) => a.verdict === "insensitive")) return { verdict: "insensitive" };
  const errored = input.mutations.filter(mutationErrored).length;
  if (errored > 0) {
    return { verdict: "inconclusive", reason: `${errored} of ${input.mutations.length} mutated replays errored, so the proof has a gap; retry it` };
  }
  if (paired.every((a) => a.verdict === "sensitive")) return { verdict: "sensitive" };
  const refusals = input.assertions.map((a) => a.targetedRefusal).filter((r): r is string => r !== undefined);
  if (refusals.length > 0) {
    return { verdict: "inconclusive", reason: `some paired assertions were neither proven nor shown vacuous (cascade, not-applied or error); a targeted proof was refused: ${refusals[0]}` };
  }
  return { verdict: "inconclusive", reason: "some paired assertions were neither proven nor shown vacuous (cascade, not-applied or error)" };
}

// ---------------------------------------------------------------------------------------------
// Evidence → the shapes above.
// ---------------------------------------------------------------------------------------------

/** A stalled replay never finished, so it proves no more than one that errored. */
function outcomeOf(o: ReplayEvidence["outcome"]): RunOutcome {
  return o === "stalled" ? "error" : o;
}

function failedOf(r: ReplayEvidence): MutationFailedSite[] {
  return r.failedSites.map((f): MutationFailedSite => {
    if (f.where === "step") return { where: "step", step: f.step, postcondition: f.postcondition };
    if (f.where === "step-request") return { where: "step-request", step: f.step, checkIndex: f.checkIndex };
    if (f.where === "end-state") return { where: "end-state", index: f.index };
    return { where: "unevaluable" };
  });
}

function lastOf(replays: readonly ReplayEvidence[], pick: (r: ReplayEvidence) => boolean): ReplayEvidence | undefined {
  return replays.filter(pick).at(-1);
}

const cut = (r: ReplayEvidence): { waitsCut?: readonly string[] } => (r.waitsCut === undefined || r.waitsCut.length === 0 ? {} : { waitsCut: r.waitsCut });

/**
 * One `MutationRunResult` per mutation that has a `mutated` replay. Replays are read in ordinal
 * order and the last of a role wins. An `at-base-time` replay belongs to the `mutated` or `relaxed`
 * replay of its mutation just before it. A `targeted` replay (and its `control`) names its target in
 * `site`; a targeted replay whose `waitsCut` names its own target was struck by the gatherer (its
 * failure did not reproduce) and counts as refused.
 */
export function mutationResults(ev: MutationEvidence): Map<string, MutationRunResult> {
  const replays = [...ev.replays].sort((a, b) => a.ordinal - b.ordinal);
  const out = new Map<string, MutationRunResult>();
  for (const m of ev.plan.mutations) {
    const mine = replays.filter((r) => r.mutation === m.id);
    const mutated = lastOf(mine, (r) => r.role === "mutated");
    if (mutated === undefined) continue;
    const relaxed = lastOf(mine, (r) => r.role === "relaxed");
    const atBaseTimeOf = (owner: ReplayEvidence): BaseTimedRun | undefined => {
      const run = lastOf(mine, (r) => r.role === "at-base-time" && lastOf(mine, (o) => (o.role === "mutated" || o.role === "relaxed") && o.ordinal < r.ordinal) === owner);
      return run === undefined ? undefined : { outcome: outcomeOf(run.outcome), failedSites: failedOf(run) };
    };
    const targetSites = [...new Set(mine.filter((r) => r.role === "targeted" && r.site !== undefined).map((r) => r.site!))];
    const targeted = targetSites.map((site): TargetedProof => {
      const run = lastOf(mine, (r) => r.role === "targeted" && r.site === site)!;
      const control = lastOf(mine, (r) => r.role === "control" && r.site === site);
      return {
        site,
        relaxedSites: run.relaxedSites ?? [],
        outcome: outcomeOf(run.outcome),
        failedSites: failedOf(run),
        ...(run.waitsCut?.includes(site) === true ? { refused: `the targeted proof of ${site} failed once and did not reproduce` } : {}),
        ...(control === undefined ? {} : { control: outcomeOf(control.outcome) }),
      };
    });
    const control = lastOf(mine, (r) => r.role === "control" && r.site === undefined);
    const rerun = lastOf(mine, (r) => r.role === "rerun");
    const mainAtBase = atBaseTimeOf(mutated);
    const relaxedAtBase = relaxed === undefined ? undefined : atBaseTimeOf(relaxed);
    out.set(m.id, {
      outcome: outcomeOf(mutated.outcome),
      failedSites: failedOf(mutated),
      ...cut(mutated),
      ...(relaxed === undefined
        ? {}
        : { relaxed: { outcome: outcomeOf(relaxed.outcome), failedSites: failedOf(relaxed), ...cut(relaxed), ...(relaxedAtBase === undefined ? {} : { atBaseTime: relaxedAtBase }) } }),
      ...(targeted.length === 0 ? {} : { targeted }),
      ...(control === undefined ? {} : { control: outcomeOf(control.outcome) }),
      ...(mainAtBase === undefined ? {} : { atBaseTime: mainAtBase }),
      ...(rerun === undefined ? {} : { rerun: outcomeOf(rerun.outcome) }),
    });
  }
  return out;
}

/** Why the replays may not have stayed independent, read from the independence and closing replays. */
function notIsolatedOf(ev: MutationEvidence): string | undefined {
  if (!ev.isolation.known) return `the proof could not establish that the replays stayed independent (${ev.isolation.reason}); retry it`;
  if (ev.isolation.value === "state-crossed") return "the independence replay showed state from one replay reaching the next; isolate the replays (a fixture restore, or a longer job's end) and run the proof again";
  const closing = lastOf([...ev.replays].sort((a, b) => a.ordinal - b.ordinal), (r) => r.role === "closing");
  if (closing === undefined || closing.outcome === "passed") return undefined;
  if (closing.outcome === "failed") return "the Journey as recorded no longer passes after the mutated replays, so state one left behind may have decided another; isolate the replays (a fixture restore, or a longer job's end) and run the proof again";
  return "the closing replay as recorded errored, so the proof cannot say the replays stayed isolated; retry it";
}

// ---------------------------------------------------------------------------------------------
// The v1 verdict.
// ---------------------------------------------------------------------------------------------

/** §5.1-5.2: a proof counts for a strict gate only in test mode (`trust: test` or `harness`), on a target that can be reset. */
export function countsForGate(trust: RunEvidence["run"]["target"]["trust"]): boolean {
  return trust === "test" || trust === "harness";
}

/** The deciding reading's boolean, or undefined when it is unknown or was not read in a fresh session. */
function decidingValue(r: DoneReading): boolean | undefined {
  if (r.session !== "fresh" || !r.value.known) return undefined;
  return r.value.value;
}

/** §3.1: the done-check table. `inRun` is never read: it is an extra reading, never the deciding one. */
export function judgeDoneCheck(done: DoneCheckEvidence | undefined): JobVerdict {
  if (done === undefined) return { attainment: "unverified", basis: "no-check" };
  const before = decidingValue(done.before);
  if (before === undefined) return { attainment: "unverified", basis: "reading-unknown" };
  if (before) return { attainment: "unverified", basis: "already-true" };
  const after = decidingValue(done.after);
  if (after === undefined) return { attainment: "unverified", basis: "reading-unknown" };
  return { attainment: after ? "achieved" : "not-achieved", basis: "done-check" };
}

/** §5.1: a harness is a UI over a mock backend; it shows feasibility only, never a job verdict. */
export function judgeJob(evidence: RunEvidence): JobVerdict {
  if (evidence.run.target.trust === "harness") return { attainment: "unverified", basis: "harness" };
  return judgeDoneCheck(evidence.doneCheck);
}

const JOB_REASONS: Record<JobVerdict["basis"], (j: JobVerdict) => string> = {
  "done-check": (j) => (j.attainment === "achieved" ? "the done check read false before the run and true after it, in a fresh session" : "the done check read false before the run and still false after it, in a fresh session"),
  "already-true": () => "the done check was already true before the run, so the run proves nothing either way; make the Journey create its own data",
  "reading-unknown": () => "a done-check reading could not be established in a fresh session, so the job is unverified",
  "no-check": () => "no done check is declared for this job, so the job is unverified",
  harness: () => "the target is a harness over a mock backend: it shows feasibility only, never a job verdict",
};

/** §6.2: a run that stopped at a boundary is inconclusive. */
export function judgeBoundary(b: BoundaryEvidence): BoundaryVerdict {
  return { outcome: "inconclusive", kind: b.kind, step: b.step, signal: b.signal, ...(b.origin === undefined ? {} : { origin: b.origin }) };
}

/** The mutation proof's verdict, from the evidence. A boundary in the run leaves the proof inconclusive. */
export function judgeChecks(evidence: RunEvidence, mutation: MutationEvidence): ChecksVerdict {
  const sites = mutation.plan.sites.map((s) => parseSiteKey(s.site)).filter((s): s is AssertionSite => s !== undefined);
  const plan: MutationPlan = { mutations: mutation.plan.mutations, pairs: mutation.plan.pairs };
  const results = mutationResults(mutation);
  const proofs = judgeAssertions(sites, plan, results);
  const notIsolated = notIsolatedOf(mutation);
  const base = lastOf([...mutation.replays].sort((a, b) => a.ordinal - b.ordinal), (r) => r.role === "base");
  const judged = mutationProofVerdict({
    basePassed: base?.outcome === "passed",
    mutations: [...results.values()],
    assertions: proofs,
    restoreFailed: mutation.restore === "failed",
    ...(notIsolated === undefined ? {} : { notIsolated }),
  });
  const unnamed = mutation.plan.sites.find((s) => parseSiteKey(s.site) === undefined);
  const { verdict, reason } =
    evidence.boundary !== undefined
      ? { verdict: "inconclusive" as const, reason: `the run stopped at a ${evidence.boundary.kind} boundary at step ${evidence.boundary.step}, so the proof proves nothing either way` }
      : unnamed !== undefined && judged.verdict === "sensitive"
        ? { verdict: "inconclusive" as const, reason: `the plan names an assertion site ${unnamed.site} that is not a site key, so it was not judged` }
        : judged;
  const assertions = proofs.map(({ site, verdict: v, provedBy, relaxedSites }): AssertionResult => ({
    site,
    verdict: v satisfies AssertionVerdict,
    ...(provedBy === undefined ? {} : { provedBy }),
    ...(relaxedSites === undefined ? {} : { relaxedSites }),
  }));
  return { verdict, assertions, ...(reason === undefined ? {} : { reason }), countsForGate: countsForGate(evidence.run.target.trust) };
}

export function judgeV1(evidence: RunEvidence): Verdict {
  const job = judgeJob(evidence);
  const reasons: string[] = [JOB_REASONS[job.basis](job)];
  const checks = evidence.mutation === undefined ? undefined : judgeChecks(evidence, evidence.mutation);
  if (checks?.reason !== undefined) reasons.push(checks.reason);
  if (checks !== undefined && !checks.countsForGate) reasons.push("a proof's strength depends on a target you can reset, so this one does not count for a strict gate");
  const boundary = evidence.boundary === undefined ? undefined : judgeBoundary(evidence.boundary);
  if (boundary !== undefined) {
    reasons.push(`the run stopped at a ${boundary.kind} boundary (${boundary.signal}) at step ${boundary.step}${boundary.origin === undefined ? "" : ` on ${boundary.origin}`}; it proves nothing either way`);
  }
  return {
    rules: "v1",
    job,
    ...(checks === undefined ? {} : { checks }),
    ...(boundary === undefined ? {} : { boundary }),
    reasons,
  };
}
