import type { Assertion, OutcomeWait, RecordedStep, Step } from "@jevitate/recording";
import { WAIT_FOR_STALL_MS } from "@jevitate/recording";
import type { Journey } from "./journey.js";
import { isNoClaimExpect, journeyAssertions, type JourneyAssertionSite } from "./assertions.js";
import { journeyWriteSteps, type JourneyLintOptions } from "./lint.js";
import { resolveJourneyStep } from "./anchors.js";

/**
 * #402 — the pure half of `journey verify --mutate`, a built-in negative proof: an assertion is only
 * evidence if it FAILS when its outcome is absent. The Journey is replayed once as recorded, then
 * once per mutation; each mutation must break the assertion(s) paired with it, for that reason.
 *
 * Mutations are safe by construction: they skip one step's action, ABORT the app's own write
 * requests inside one step's window, or type an empty value into one fill — never send, fabricate
 * or answer a request.
 *
 *  - `skip:<n>` — a write step's action is left out (its own `expect`, when it has one, is still
 *    checked at the same place, so a claim that holds without the action is caught);
 *  - `block-write:<n>` — the write requests a write step sends are aborted before they leave the
 *    browser (`mutationReplay` names the step's recorded writes; one of them must be blocked, or the
 *    mutation was not applied);
 *  - `stale-value:<n>` — a fill whose value an assertion checks (`valueEquals`/`textIncludes`)
 *    types `""` instead.
 */

export type MutationKind = "skip" | "block-write" | "stale-value";

export interface JourneyMutation {
  readonly kind: MutationKind;
  /** 1-based, the way `--at-step` counts. */
  readonly step: number;
  /** `<kind>:<step>`, e.g. `skip:3` — what a report and `provedBy` name. */
  readonly id: string;
}

/** One (assertion site, mutation) pair: the mutation must make that assertion fail. */
export interface MutationPair {
  /** The site key (`assertionSiteKey`). */
  readonly site: string;
  /** The mutation id. */
  readonly mutation: string;
  /** Declared in `metadata.mutationPairs` (else derived from the Journey). */
  readonly declared?: true;
}

export interface MutationPlan {
  readonly mutations: readonly JourneyMutation[];
  readonly pairs: readonly MutationPair[];
}

/** Where a mutated replay failed. `postcondition`: the step's own assertion failed (not its action). */
export type MutationFailedSite =
  | { readonly where: "step"; readonly step: number; readonly postcondition: boolean }
  | { readonly where: "step-request"; readonly step: number; readonly checkIndex: number }
  | { readonly where: "end-state"; readonly index: number }
  | { readonly where: "unevaluable" };

/** A mutated replay: it passed, failed (where), was not applied (nothing to mutate), or errored. */
export interface MutationRunResult {
  readonly outcome: "passed" | "failed" | "not-applied" | "error";
  readonly failedSites: readonly MutationFailedSite[];
}

/** sensitive: broke for the right reason · insensitive: still passed (vacuous) · cascade: broke elsewhere. */
export type MutationVerdict = "sensitive" | "insensitive" | "cascade" | "not-applied" | "error";
export type AssertionVerdict = MutationVerdict | "unpaired";

export interface AssertionProof {
  readonly site: string;
  readonly verdict: AssertionVerdict;
  /** The mutation that proved it sensitive. */
  readonly provedBy?: string;
}

/** `step:<n>` · `step-request:<n>:<i>` · `end-state:<i>` — the names `metadata.mutationPairs` uses. */
export function assertionSiteKey(site: JourneyAssertionSite): string {
  if (site.where === "step") return `step:${site.step}`;
  if (site.where === "step-request") return `step-request:${site.step}:${site.checkIndex}`;
  return `end-state:${site.index}`;
}

const MUTATION_RE = /^(skip|block-write|stale-value):(.+)$/;
const SITE_RE = /^(?:step:[1-9][0-9]*|step-request:[1-9][0-9]*:(?:0|[1-9][0-9]*)|end-state:(?:0|[1-9][0-9]*))$/;

function flat(journey: Journey): RecordedStep[] {
  return journey.recording.pages.flatMap((p) => p.steps);
}

function mutation(kind: MutationKind, step: number): JourneyMutation {
  return { kind, step, id: `${kind}:${step}` };
}

/** Resolves a `mustFailWhen` (`skip:<n|anchor>`, …) against the Journey; throws a readable Error. */
function resolveMutationRef(journey: Journey, value: string): JourneyMutation {
  const m = MUTATION_RE.exec(value.trim());
  if (m === null) throw new Error(`${JSON.stringify(value)} is not a mutation — expected skip:<step>, block-write:<step> or stale-value:<step> (a step number or an anchor name)`);
  const ref = m[2]!;
  let step: number;
  try {
    step = resolveJourneyStep(journey, ref).step;
  } catch (err) {
    const why = err instanceof Error ? err.message.replace(/^--at-step /, "") : String(err);
    throw new Error(`${JSON.stringify(value)}: ${why}`);
  }
  const kind = m[1] as MutationKind;
  if (kind === "stale-value" && flat(journey)[step - 1]?.step.kind !== "fill") {
    throw new Error(`${JSON.stringify(value)}: step ${step} is not a fill step (stale-value types an empty value into a fill)`);
  }
  return mutation(kind, step);
}

/**
 * #402: what is wrong with `metadata.mutationPairs` — an unknown assertion site, a step or anchor the
 * Journey does not have, a stale-value on a step that is not a fill. Empty when every pair resolves.
 */
export function mutationPairIssues(journey: Journey): { readonly index: number; readonly field: "check" | "mustFailWhen"; readonly message: string }[] {
  const pairs = journey.metadata.mutationPairs ?? [];
  if (pairs.length === 0) return [];
  const sites = new Set(journeyAssertions(journey).map(assertionSiteKey));
  const out: { index: number; field: "check" | "mustFailWhen"; message: string }[] = [];
  pairs.forEach((pair, index) => {
    if (!SITE_RE.test(pair.check)) {
      out.push({ index, field: "check", message: `mutationPairs: ${JSON.stringify(pair.check)} is not an assertion site — expected step:<n>, step-request:<n>:<i> or end-state:<i>` });
    } else if (!sites.has(pair.check)) {
      out.push({ index, field: "check", message: `mutationPairs: the Journey has no assertion at ${pair.check}` });
    }
    try {
      resolveMutationRef(journey, pair.mustFailWhen);
    } catch (err) {
      out.push({ index, field: "mustFailWhen", message: `mutationPairs: ${err instanceof Error ? err.message : String(err)}` });
    }
  });
  return out;
}

/** The text a `valueEquals`/`textIncludes` assertion expects, else null. */
function expectedText(a: Assertion): { kind: "valueEquals" | "textIncludes"; text: string } | null {
  if (a.kind === "valueEquals") return { kind: a.kind, text: a.value };
  if (a.kind === "textIncludes") return { kind: a.kind, text: a.text };
  return null;
}

function siteAssertion(site: JourneyAssertionSite): Assertion | null {
  if (site.where === "step") return site.check.assertion;
  if (site.where === "end-state" && (site.check.kind === "page" || site.check.kind === "reloadThen")) return site.check.assertion;
  return null;
}

/** Does this assertion check the value `v` a fill typed? */
function checksValue(site: JourneyAssertionSite, v: string): boolean {
  const a = siteAssertion(site);
  const e = a === null ? null : expectedText(a);
  if (e === null) return false;
  return e.kind === "valueEquals" ? e.text === v : e.text.includes(v);
}

/** A fill's typed value, when it is known here (a literal, or a param given in `params`). */
function fillValue(step: Step, params: Readonly<Record<string, string>>): string | null {
  if (step.kind !== "fill") return null;
  const v = step.value;
  if ("var" in v) return params[v.var] ?? null;
  return v.redacted ? null : v.value;
}

/**
 * #402: the Journey's mutations and which assertion each must break. Derived pairs: a write step's
 * `skip`/`block-write` with that step's own `expect`/`check` and `expectRequests` — and, for the LAST
 * write step, every end-state check; a fill's `stale-value` with that step's own assertion and every
 * `valueEquals`/`textIncludes` that checks the typed value. Plus `metadata.mutationPairs` (anchors resolved).
 * An explicit no-claim `expect` (`isNoClaimExpect`) asserts nothing, so it is never paired.
 */
export function planJourneyMutations(
  journey: Journey,
  opts: JourneyLintOptions & { readonly params?: Readonly<Record<string, string>> } = {},
): MutationPlan {
  const steps = flat(journey);
  // An explicit "no claim" expect (`count min 0`, `urlIncludes ""`) asserts nothing: never paired.
  const sites = journeyAssertions(journey).filter((s) => !(s.where === "step" && s.field === "expect" && isNoClaimExpect(steps[s.step - 1]!.step)));
  const mutations: JourneyMutation[] = [];
  const pairs: MutationPair[] = [];
  const pair = (site: JourneyAssertionSite, m: JourneyMutation): void => {
    const key = assertionSiteKey(site);
    if (!pairs.some((p) => p.site === key && p.mutation === m.id)) pairs.push({ site: key, mutation: m.id });
  };
  const ownSites = (n: number): JourneyAssertionSite[] => sites.filter((s) => (s.where === "step" || s.where === "step-request") && s.step === n);

  const writes = journeyWriteSteps(journey, opts);
  const lastWrite = writes.at(-1)?.step;
  for (const w of writes) {
    for (const kind of ["skip", "block-write"] as const) {
      const m = mutation(kind, w.step);
      mutations.push(m);
      for (const s of ownSites(w.step)) pair(s, m);
      if (w.step === lastWrite) for (const s of sites) if (s.where === "end-state") pair(s, m);
    }
  }

  steps.forEach((recorded, i) => {
    const v = fillValue(recorded.step, opts.params ?? {});
    if (v === null || v === "") return;
    const checking = sites.filter((s) => checksValue(s, v));
    if (checking.length === 0) return;
    const m = mutation("stale-value", i + 1);
    mutations.push(m);
    for (const s of ownSites(i + 1)) pair(s, m);
    for (const s of checking) pair(s, m);
  });

  for (const declared of journey.metadata.mutationPairs ?? []) {
    const m = resolveMutationRef(journey, declared.mustFailWhen);
    if (!mutations.some((x) => x.id === m.id)) mutations.push(m);
    const i = pairs.findIndex((p) => p.site === declared.check && p.mutation === m.id);
    if (i >= 0) pairs.splice(i, 1);
    pairs.push({ site: declared.check, mutation: m.id, declared: true });
  }
  return { mutations, pairs };
}

/**
 * #409: a waited claim on the mutated step itself waits at most the hang threshold (its `stallMs`,
 * default `WAIT_FOR_STALL_MS`) — the job was skipped or its writes blocked, so the outcome must be
 * absent; waiting out a long `maxMs` would only make the proof slow. It still FAILS (times out, or
 * hangs on its progress signal), at that step, as a postcondition: the sensitive verdict.
 */
export function mutationWait(wait: OutcomeWait): OutcomeWait {
  // The cap sits a margin PAST the stall threshold: capped exactly at it, the final poll could reach
  // maxMs a few ms before the stall measured stallMs, and a hang would read as a plain timeout.
  return { ...wait, maxMs: Math.min(wait.maxMs, (wait.stallMs ?? WAIT_FOR_STALL_MS) + MUTATION_WAIT_MARGIN_MS) };
}

/** #409: how far past the stall threshold a mutated step's wait may run, so its hang is named as one. */
const MUTATION_WAIT_MARGIN_MS = 5_000;

/**
 * #402: how to replay one mutation. `journey` is what the replay runs (a copy when the mutation
 * changes a step; the input is never modified, and no step is ever removed, so indices hold);
 * `skipIndex` (0-based) is a step the interpreter leaves out; `blockIndex` (0-based) is the step
 * whose window has its writes aborted, `blockRequests` its recorded write request lines.
 */
export function mutationReplay(
  journey: Journey,
  m: JourneyMutation,
  opts: JourneyLintOptions = {},
): { readonly journey: Journey; readonly skipIndex?: number; readonly blockIndex?: number; readonly blockRequests?: readonly string[] } {
  const index = m.step - 1;
  if (m.kind === "block-write") {
    const requests = journeyWriteSteps(journey, opts).find((w) => w.step === m.step)?.requests ?? [];
    const step = flat(journey)[index]?.step;
    // #409: the blocked job never runs, so its waited claim waits at most the hang threshold.
    if (step === undefined || !("waitFor" in step) || step.waitFor === undefined) return { journey, blockIndex: index, blockRequests: [...requests] };
    const copy = structuredClone(journey);
    const target = flat(copy)[index]!;
    target.step = { ...step, waitFor: mutationWait(step.waitFor) } as Step;
    return { journey: copy, blockIndex: index, blockRequests: [...requests] };
  }
  const step = flat(journey)[index]?.step;
  if (step === undefined) throw new Error(`journey '${journey.metadata.id}' has no step ${m.step}`);
  if (m.kind === "skip" && !("expect" in step)) return { journey, skipIndex: index };
  const copy = structuredClone(journey);
  const target = flat(copy)[index]!;
  if (m.kind === "skip" && "expect" in step) {
    // The action is left out; its own claim is still checked where it stood — a waited claim (#409)
    // still waits, but at most the hang threshold: the job it waits on was never started.
    target.step = {
      kind: "assert",
      ...(step.label === undefined ? {} : { label: step.label }),
      check: step.expect,
      ...(step.waitFor === undefined ? {} : { waitFor: mutationWait(step.waitFor) }),
    };
  } else if (m.kind === "stale-value" && target.step.kind === "fill") {
    target.step = { ...target.step, value: { redacted: false, value: "" } };
  }
  return { journey: copy };
}

/**
 * #402: one assertion against one mutated replay. Sensitive only when the replay failed AT that
 * assertion and nothing failed before the mutated step — a failure anywhere else is a cascade,
 * never counted as proof.
 */
export function classifyMutation(site: JourneyAssertionSite, m: JourneyMutation, result: MutationRunResult): MutationVerdict {
  if (result.outcome === "passed") return "insensitive";
  if (result.outcome === "not-applied") return "not-applied";
  if (result.outcome === "error") return "error";
  const fs = result.failedSites;
  if (site.where === "step") {
    const hit = fs.some((f) => f.where === "step" && f.step === site.step && f.postcondition);
    return hit && site.step >= m.step ? "sensitive" : "cascade";
  }
  // A step failed (the outcome checks were never judged), or the end state could not be read.
  if (fs.some((f) => f.where === "step" || f.where === "unevaluable")) return "cascade";
  if (fs.some((f) => f.where === "step-request" && f.step < m.step)) return "cascade";
  if (site.where === "step-request") {
    if (site.step < m.step) return "cascade";
    return fs.some((f) => f.where === "step-request" && f.step === site.step && f.checkIndex === site.checkIndex) ? "sensitive" : "cascade";
  }
  return fs.some((f) => f.where === "end-state" && f.index === site.index) ? "sensitive" : "cascade";
}

const PRECEDENCE: readonly MutationVerdict[] = ["sensitive", "insensitive", "cascade", "not-applied", "error"];

/**
 * #402: every assertion's verdict over its paired mutations — sensitive when ANY paired mutation
 * broke it for the right reason (`provedBy` the first), else insensitive when one passed, else
 * cascade / not-applied / error; `unpaired` when no mutation is paired with it.
 */
export function judgeAssertions(journey: Journey, plan: MutationPlan, results: ReadonlyMap<string, MutationRunResult>): AssertionProof[] {
  return journeyAssertions(journey).map((site) => {
    const key = assertionSiteKey(site);
    const paired = plan.mutations.filter((m) => plan.pairs.some((p) => p.site === key && p.mutation === m.id));
    if (paired.length === 0) return { site: key, verdict: "unpaired" };
    const verdicts = paired.map((m) => ({ m, v: classifyMutation(site, m, results.get(m.id) ?? { outcome: "error", failedSites: [] }) }));
    for (const v of PRECEDENCE) {
      const first = verdicts.find((x) => x.v === v);
      if (first === undefined) continue;
      return v === "sensitive" ? { site: key, verdict: v, provedBy: first.m.id } : { site: key, verdict: v };
    }
    return { site: key, verdict: "error" };
  });
}

/** #402: the proof's verdict — exit 0 `proven`, 1 `insensitive`, 2 `inconclusive` (docs/ci.md). */
export type MutationProofVerdict = "proven" | "insensitive" | "inconclusive";

/**
 * #402: proven when every PAIRED assertion is sensitive; insensitive when any paired assertion still
 * passed under its mutation; inconclusive when the unmutated replay failed, every mutation errored,
 * nothing was paired, or what is left is only cascades / not-applied (nothing proven either way).
 */
export function mutationProofVerdict(input: {
  readonly basePassed: boolean;
  readonly mutations: readonly Pick<MutationRunResult, "outcome">[];
  readonly assertions: readonly AssertionProof[];
}): { readonly verdict: MutationProofVerdict; readonly reason?: string } {
  if (!input.basePassed) return { verdict: "inconclusive", reason: "the unmutated replay failed — no mutation was run" };
  if (input.mutations.length > 0 && input.mutations.every((m) => m.outcome === "error")) {
    return { verdict: "inconclusive", reason: "every mutated replay errored" };
  }
  const paired = input.assertions.filter((a) => a.verdict !== "unpaired");
  if (paired.length === 0) return { verdict: "inconclusive", reason: "no assertion is paired with a mutation (no write step, no checked fill, no mutationPairs)" };
  if (paired.some((a) => a.verdict === "insensitive")) return { verdict: "insensitive" };
  if (paired.every((a) => a.verdict === "sensitive")) return { verdict: "proven" };
  return { verdict: "inconclusive", reason: "some paired assertions were neither proven nor shown vacuous (cascade, not-applied or error)" };
}
