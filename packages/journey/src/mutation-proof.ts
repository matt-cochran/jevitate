import type { Assertion, RecordedStep, Step } from "@jevitate/recording";
import { canonicalJson, expandBraces, matchGlob } from "@jevitate/domain";
import { classifyMutation, classifyMutationPlain, evaluatedOwnRequestFailure, type MutationKindSchema } from "@jevitate/adjudicator";
import type { Journey } from "./journey.js";
import { isNoClaimExpect, journeyAssertions, type JourneyAssertionSite } from "./assertions.js";
import { journeyMutationSteps, journeyWriteSteps, type JourneyLintOptions } from "./lint.js";
import { actionRefs, mutableParamValue, sitePageAssertion, siteRefs, swappedValue, truncatedValue } from "./mutation-proof-refs.js";
import { outcomeIdentity } from "./mutation-proof-types.js";
import { flat, mutationWait } from "./mutation-proof-pace.js";
import {
  assertionSiteKey,
  firstActionStep,
  guardSites,
  mutation,
  paramMutation,
  paramReplay,
  resolveMutationRef,
  reviewedValue,
  SITE_RE,
  staleValue,
  varFillRef,
  type MutationReplayOptions,
} from "./mutation-proof-targeted.js";
export {
  MAX_DECLARED_RELAXATIONS,
  MAX_TARGETED_RELAXATIONS,
  assertionSiteKey,
  declaredTargetedProofFor,
  endStateIsolationNotes,
  nextTargetedRelaxation,
  relaxedMutationReplay,
  runDeclaredTargetedProof,
  runTargetedProof,
  suggestTargetedProofPlan,
  targetedControlReplay,
  targetedMutationReplay,
  targetedProofPlanIssues,
} from "./mutation-proof-targeted.js";
export type { MutationReplayOptions } from "./mutation-proof-targeted.js";
export {
  heldSites,
  mutationWait,
  paceBeforeMutationMs,
  paceEndStateFloorMs,
  paceFloorMs,
  paceMarginBoundMs,
  paceMarginOf,
  paceTailMs,
  pacedReplay,
  sitesReachedEarly,
  sitesUnmatchedBy,
  thinSites,
} from "./mutation-proof-pace.js";
import type {
  JourneyMutation,
  MutationFailedSite,
  MutationKind,
  MutationPair,
  MutationPlan,
  MutationReplay,
  MutationRunResult,
  MutationVerdict,
  RelaxedSiteWait,
  SiteArrivals,
  SiblingDisagreement,
  SwapSource,
  TargetedProof,
  TargetedReplayRun,
} from "./mutation-proof-types.js";
export type {
  AssertionProof,
  AssertionVerdict,
  BaseTimedRun,
  JourneyMutation,
  MutationFailedSite,
  MutationKind,
  MutationPair,
  MutationPlan,
  MutationReplay,
  MutationRunResult,
  MutationVerdict,
  ReplayHolds,
  ReplayPace,
  SiteArrivals,
  SiblingDisagreement,
  SwapSource,
  TargetedProof,
} from "./mutation-proof-types.js";

type SameKinds<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;

const _kindsMirrored: SameKinds<MutationKind, import("zod").infer<typeof MutationKindSchema>> = true;
void _kindsMirrored;

/** A check's kind, and a network check's method when it is a plain word: never a path, text or value. */
function checkShape(site: JourneyAssertionSite): string {
  const check = site.check;
  if (check.kind === "page" || check.kind === "reloadThen") return `${check.kind} ${check.assertion.kind}`;
  if ((check.kind === "requestMade" || check.kind === "responseStatus") && /^[A-Za-z]{1,16}$/.test(check.method)) return `${check.kind} ${check.method.toUpperCase()}`;
  return check.kind;
}

/**
 * #812: what the adjudicator reads about each of a Journey's assertion sites (`MutationEvidence.plan.sites`),
 * in `journeyAssertions` order: its key, its check's kind first (the v1 rules read a network check by that
 * word), and #811's `required` — an own request check, or an end state that is not a page check, which
 * leaves the proof inconclusive when nothing is paired with it. Value-free.
 */
export function mutationPlanSites(journey: Journey): { readonly site: string; readonly check: string; readonly required?: true }[] {
  return journeyAssertions(journey).map((site) => ({
    site: assertionSiteKey(site),
    check: checkShape(site),
    ...(site.where === "step-request" || (site.where === "end-state" && site.check.kind !== "page") ? { required: true as const } : {}),
  }));
}

/**
 * #579: does every action that reads `name` read it at a `select`? Then a truncated value is no valid
 * selection probe (a swap proves it by picking a different live option instead).
 */
function allActionReadsAreSelect(journey: Journey, name: string): boolean {
  const reads = flat(journey).filter((r) => actionRefs(r.step).includes(name));
  return reads.length > 0 && reads.every((r) => r.step.kind === "select");
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

/**
 * The literal text a `valueEquals`/`textIncludes` assertion expects, else null. A `{ var }` operand
 * (#565) is not a literal: it derives no stale-value pair here.
 */
function expectedText(a: Assertion): { kind: "valueEquals" | "textIncludes"; text: string } | null {
  if (a.kind === "valueEquals") return typeof a.value === "string" ? { kind: a.kind, text: a.value } : null;
  if (a.kind === "textIncludes") return typeof a.text === "string" ? { kind: a.kind, text: a.text } : null;
  return null;
}

/** Does this assertion check the value `v` a fill typed? */
function checksValue(site: JourneyAssertionSite, v: string): boolean {
  const a = sitePageAssertion(site);
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

/** A positive request matcher used for provenance and blocked-write applicability. */
export function mutationWriteMatches(expected: { readonly method: string; readonly pathGlob: string; readonly literal?: true }, actual: { readonly method: string; readonly path: string }): boolean {
  if (expected.method !== "*" && expected.method.toUpperCase() !== actual.method.toUpperCase()) return false;
  const absolute = /^https?:\/\//i.test(expected.pathGlob);
  const normalize = (path: string): string => {
    try {
      return /^https?:\/\//i.test(path) ? (absolute ? new URL(path).origin + new URL(path).pathname : new URL(path).pathname) : path.split("?")[0]!;
    } catch {
      return path;
    }
  };
  if (expected.literal === true) return normalize(expected.pathGlob) === normalize(actual.path);
  return matchGlob(normalize(expected.pathGlob), normalize(actual.path));
}

function requestRelation(expected: { readonly method: string; readonly pathGlob: string }, candidate: { readonly method: string; readonly pathGlob: string; readonly literal?: true }): "definite" | "possible" | "none" {
  if (expected.method !== "*" && expected.method.toUpperCase() !== candidate.method.toUpperCase()) return "none";
  const patterned = (path: string): boolean => path.includes("*") || expandBraces(path).length > 1;
  if (candidate.literal === true || !patterned(candidate.pathGlob)) return mutationWriteMatches(expected, { method: candidate.method, path: candidate.pathGlob }) ? "definite" : "none";
  if (expected.pathGlob === candidate.pathGlob) return "definite";
  if (!patterned(expected.pathGlob)) return mutationWriteMatches(candidate, { method: candidate.method, path: expected.pathGlob }) ? "possible" : "none";
  // Unresolved pattern intersections are possible owners, never positive provenance.
  return "possible";
}

function ownsFinalUiOutcome(recorded: RecordedStep, assertion: Assertion): boolean {
  return "expect" in recorded.step && canonicalJson(outcomeIdentity(recorded.step.expect)) === canonicalJson(outcomeIdentity(assertion));
}

/**
 * #402: the Journey's mutations and which assertion each must break. UI actions get skips;
 * positively evidenced HTTP writes also get blocks. Own checks pair with their action, final UI
 * checks with the last effect only when its own outcome matches symbolically (or it is an HTTP
 * write), and network checks with their unique originating request step.
 * A fill's `stale-value` pairs with that step's own assertion and every
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

  const candidates = journeyMutationSteps(journey, opts);
  const lastEffect = candidates.at(-1)?.step;
  for (const w of candidates) {
    for (const kind of w.knownHttpWrite ? ["skip", "block-write"] as const : ["skip"] as const) {
      const m = mutation(kind, w.step);
      mutations.push(m);
      for (const s of ownSites(w.step)) pair(s, m);
      for (const s of sites) {
        if (s.where !== "end-state") continue;
        const check = s.check;
        if (check.kind === "page" || check.kind === "reloadThen" || check.kind === "http") {
          if (w.step === lastEffect && (w.knownHttpWrite || (check.kind === "page" && ownsFinalUiOutcome(steps[w.step - 1]!, check.assertion)))) pair(s, m);
          continue;
        }
        // Request checks belong to the unique matching originating step. Ambiguous
        // provenance stays unpaired until an explicit causal pair is supplied.
        const relations = candidates.map((candidate) => ({ candidate, relations: candidate.requests.map((request) => requestRelation(check, request)) }));
        const possible = relations.filter((entry) => entry.relations.some((relation) => relation !== "none"));
        if (possible.length === 1 && possible[0]!.candidate.step === w.step && possible[0]!.relations.includes("definite")) pair(s, m);
      }
    }
  }

  steps.forEach((recorded, i) => {
    const v = fillValue(recorded.step, opts.params ?? {});
    const ref = varFillRef(journey, recorded.step, opts.params ?? {});
    if ((v === null || v === "") && ref === null) return;
    // #565: a `{ var }` fill is also checked by every assertion that names its (non-secret) variable.
    const checking = sites.filter((s) => (v !== null && v !== "" && checksValue(s, v)) || (ref !== null && siteRefs(s).includes(ref)));
    if (checking.length === 0) return;
    const m = mutation("stale-value", i + 1);
    mutations.push(m);
    for (const s of ownSites(i + 1)) pair(s, m);
    for (const s of checking) pair(s, m);
  });

  // #565: each non-secret parameter an assertion names, and an action reads, is swapped (and, unless
  // a `select` is its only read — #579 — truncated) where the app receives it, paired with every
  // assertion that names it.
  const params = opts.params ?? {};
  const names = [...new Set(sites.flatMap(siteRefs))];
  for (const name of names) {
    const supplied = mutableParamValue(journey, name, params);
    // #580: the checks that guard the input (before any action reads it) are proven by a wrong INPUT
    // for the whole run — never pinned — paired with those guards only.
    const guards = guardSites(journey, sites, name);
    const guardValue = supplied === null ? null : (reviewedValue(journey, name, supplied) ?? swappedValue(journey, name, params));
    if (guards.length > 0 && guardValue !== null) {
      const g = { ...paramMutation("guard-param", guards[0]!.step, name), source: (reviewedValue(journey, name, supplied!) === null ? "generated" : "reviewed") as SwapSource };
      mutations.push(g);
      for (const s of guards) pair(s, g);
    }
    const at = firstActionStep(journey, name);
    if (at === null) continue;
    // A guard compares the page with the input before the action, so a swap pinned to the supplied
    // value can never break it: the swap proves only the checks at or after the action.
    const naming = sites.filter((s) => siteRefs(s).includes(name) && !(guards as readonly JourneyAssertionSite[]).includes(s));
    if (naming.length === 0) continue;
    // #579: a select-fed parameter is proven by choosing another enabled live option, never by a
    // truncated value (not a valid selection). Every other parameter still gets both mutations.
    const candidates: readonly (readonly ["swap-param" | "truncate-param", string | null])[] = [
      ["swap-param", swappedValue(journey, name, params)],
      ...(allActionReadsAreSelect(journey, name) ? [] : [["truncate-param", truncatedValue(journey, name, params)] as const]),
    ];
    const source: SwapSource =
      supplied !== null && reviewedValue(journey, name, supplied) !== null ? "reviewed" : allActionReadsAreSelect(journey, name) ? "option" : "generated";
    for (const [kind, value] of candidates) {
      if (value === null) continue;
      const m = kind === "swap-param" ? { ...paramMutation(kind, at, name), source } : paramMutation(kind, at, name);
      mutations.push(m);
      for (const s of naming) pair(s, m);
    }
  }

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
 * #402: how to replay one mutation. `journey` is what the replay runs (a copy when the mutation
 * changes a step; the input is never modified, and no step is ever removed, so indices hold);
 * `skipIndex` (0-based) is a step the interpreter leaves out; `blockIndex` (0-based) is the step
 * whose window has its writes aborted, `blockRequests` its recorded write request lines.
 */
export function mutationReplay(journey: Journey, m: JourneyMutation, opts: MutationReplayOptions = {}): MutationReplay {
  const index = m.step - 1;
  if (m.kind === "swap-param" || m.kind === "truncate-param" || m.kind === "guard-param") return paramReplay(journey, m, opts.params ?? {});
  if (m.kind === "block-write") {
    const requests = journeyWriteSteps(journey, opts).find((w) => w.step === m.step)?.requests ?? [];
    const blockMatchers = journeyMutationSteps(journey, opts).find((w) => w.step === m.step)?.requests ?? [];
    const step = flat(journey)[index]?.step;
    // #409: the blocked job never runs, so its waited claim waits at most the hang threshold.
    if (step === undefined || !("waitFor" in step) || step.waitFor === undefined) return { journey, blockIndex: index, blockRequests: [...requests], blockMatchers };
    const copy = structuredClone(journey);
    const target = flat(copy)[index]!;
    target.step = { ...step, waitFor: mutationWait(step.waitFor) } as Step;
    return { journey: copy, blockIndex: index, blockRequests: [...requests], blockMatchers };
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
    target.step = { ...target.step, value: { redacted: false, value: staleValue(journey, step, opts.params ?? {}) } };
  }
  return { journey: copy };
}

/**
 * #554: does this failed result need a relaxed replay? Only when it failed first at the mutated
 * step's OWN postcondition (`{where:'step', step: m.step, postcondition: true}`) and `plan.pairs`
 * pairs `m` with at least one site other than the step's own (`step:<m.step>`) — otherwise the
 * failure is the whole story and there is nothing later to judge.
 */
export function needsRelaxedReplay(plan: MutationPlan, m: JourneyMutation, result: MutationRunResult): boolean {
  if (result.outcome !== "failed") return false;
  if (!result.failedSites.some((f) => f.where === "step" && f.step === m.step && f.postcondition)) return false;
  const own = `step:${m.step}`;
  return plan.pairs.some((p) => {
    if (p.mutation !== m.id || p.site === own) return false;
    const request = /^step-request:([1-9][0-9]*):([0-9]+)$/.exec(p.site);
    return request === null || !evaluatedOwnRequestFailure(Number(request[1]), Number(request[2]), m, result);
  });
}

/** One replay on its own, with no relaxed or targeted level: does it fail this site, pass it, or stop short of it? */
export function classifyReplay(site: JourneyAssertionSite, m: JourneyMutation, result: Pick<MutationRunResult, "outcome" | "failedSites" | "waitsCut">): MutationVerdict {
  return classifyMutationPlain(site, m, { outcome: result.outcome, failedSites: result.failedSites, ...(result.waitsCut === undefined ? {} : { waitsCut: result.waitsCut }) });
}

/**
 * Where mutations of one step disagree on a site. Skip and block can really differ (a claim on what
 * the click did, not what its write did), and a one-off slow job can make one of them fail for
 * nothing, so "any sensitive wins" (`judgeAssertions`) does not settle it until the reading reproduces.
 */
export function siblingDisagreements(journey: Journey, plan: MutationPlan, results: ReadonlyMap<string, MutationRunResult>): SiblingDisagreement[] {
  const out: SiblingDisagreement[] = [];
  for (const site of journeyAssertions(journey)) {
    const key = assertionSiteKey(site);
    const paired = plan.mutations.filter((m) => results.has(m.id) && plan.pairs.some((p) => p.site === key && p.mutation === m.id));
    const reading = (m: JourneyMutation): MutationVerdict => classifyMutation(site, m, results.get(m.id)!);
    for (const a of paired) {
      if (reading(a) !== "sensitive") continue;
      const b = paired.find((x) => x.step === a.step && x.id !== a.id && reading(x) === "insensitive");
      if (b !== undefined) out.push({ site: key, sensitive: a.id, passed: b.id });
    }
  }
  return out;
}

/**
 * Can a control over `atStake` still change the proof's verdict, given the mutations run so far? It
 * can only turn a sensitive reading away from sensitive. Once one site is finally `insensitive` the
 * verdict is decided. Once the proof cannot be `proven`, it matters only if the reading would fall to
 * a sibling's pass, seen or still to come. A taint a replay might add is the closing replay's business.
 */
export function controlCanChangeVerdict(journey: Journey, plan: MutationPlan, results: ReadonlyMap<string, MutationRunResult>, atStake: readonly string[]): boolean {
  const sites = journeyAssertions(journey);
  const pairedWith = (key: string): JourneyMutation[] => plan.mutations.filter((m) => plan.pairs.some((p) => p.site === key && p.mutation === m.id));
  const readings = (key: string): { pending: boolean; readings: MutationVerdict[] } => {
    const site = sites.find((s) => assertionSiteKey(s) === key);
    const paired = pairedWith(key);
    const ran = paired.filter((m) => results.has(m.id));
    return { pending: ran.length < paired.length, readings: site === undefined ? [] : ran.map((m) => classifyMutation(site, m, results.get(m.id)!)) };
  };
  let provable = true;
  for (const site of sites) {
    const key = assertionSiteKey(site);
    if (pairedWith(key).length === 0) continue;
    const { pending, readings: read } = readings(key);
    if (pending || read.includes("sensitive")) continue;
    if (read.includes("insensitive")) return false;
    provable = false;
  }
  if ([...results.values()].some((r) => r.outcome === "error" || r.relaxed?.outcome === "error")) provable = false;
  if (provable) return true;
  return atStake.some((key) => {
    const { pending, readings: read } = readings(key);
    return pending || read.includes("insensitive");
  });
}

/**
 * #402: the proof's verdict as `journey verify` reports it — exit 0 `sensitive`, 1 `insensitive`,
 * 2 `inconclusive` (docs/ci.md). 0.30.0 §6.1 renamed 0.29.0's `proven` to the adjudicator's `sensitive`;
 * the CLI report carries the old word as `verdictLegacy` until 0.32.0.
 */
export type { MutationProofVerdict } from "@jevitate/domain";
