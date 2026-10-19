import type { Assertion, OutcomeWait, RecordedStep, Step } from "@jevitate/recording";
import { WAIT_FOR_STALL_MS } from "@jevitate/recording";
import type { Journey } from "./journey.js";
import { isNoClaimExpect, journeyAssertions, type JourneyAssertionSite } from "./assertions.js";
import { journeyWriteSteps, type JourneyLintOptions } from "./lint.js";
import { resolveJourneyStep } from "./anchors.js";
import { secretParamNames } from "./intent.js";
import { actionRefs, alteredValue, mutableParamValue, pinAssertionRefs, sitePageAssertion, siteRefs, swappedValue, truncatedValue } from "./mutation-proof-refs.js";

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
 *    types `""` instead — or, #565, for a `{ var }` fill whose parameter an assertion names, an
 *    altered value of that parameter (the composer holds stale text, not the approved reply);
 *  - `swap-param:<name>` / `truncate-param:<name>` (#565) — the replay runs with one non-secret
 *    parameter swapped for a different plausible value, or with its tail dropped, where the app
 *    receives it (a fill, a navigate URL), while every assertion naming it still expects the
 *    supplied value: a check that cannot tell them apart is vacuous. A secret is never mutated.
 */

export type MutationKind = "skip" | "block-write" | "stale-value" | "swap-param" | "truncate-param" | "guard-param";

export interface JourneyMutation {
  readonly kind: MutationKind;
  /**
   * 1-based, the way `--at-step` counts. For a param mutation: the first step whose action reads
   * the parameter (where the mutation takes effect).
   */
  readonly step: number;
  /** `<kind>:<step>` (e.g. `skip:3`), or `<kind>:<param>` for a param mutation — what a report and `provedBy` name. */
  readonly id: string;
  /** #565: the parameter a `swap-param`/`truncate-param` alters (a name, never a value). */
  readonly param?: string;
  /**
   * #579: where a planned `swap-param`'s wrong value comes from — a human-reviewed `mutationValues`
   * entry, another enabled live `<select>` option, or a generated alteration. Never the value itself.
   */
  readonly source?: SwapSource;
}

/** #579: the origin of a `swap-param`'s wrong value (`JourneyMutation.source`). */
export type SwapSource = "reviewed" | "option" | "generated";

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

/**
 * #609 — a bounded TARGETED proof: an assertion that only looks like a `cascade` because an EARLIER
 * intentional defense caught the paired mutation first. Each `relaxedSites` entry is an earlier
 * `step:<n>` postcondition weakened in a cloned Journey so the replay could reach the target; the
 * target assertion itself is never relaxed.
 */
export interface TargetedProof {
  readonly site: string;
  readonly relaxedSites: readonly string[];
  readonly outcome: MutationRunResult["outcome"];
  readonly failedSites: readonly MutationFailedSite[];
  /** Set when no further relaxation is allowed: why the target stays a cascade. */
  readonly refused?: string;
  /** The unmutated control replay's outcome (`targetedControlReplay`), run before a targeted failure counts. */
  readonly control?: MutationRunResult["outcome"];
}

/** A mutated replay: it passed, failed (where), was not applied (nothing to mutate), or errored. */
export interface MutationRunResult {
  readonly outcome: "passed" | "failed" | "not-applied" | "error";
  readonly failedSites: readonly MutationFailedSite[];
  /**
   * #554 — the same mutation replayed with the mutated step's own postcondition relaxed (its action
   * still skipped/blocked/emptied, but its `expect`/`waitFor` left out), so a replay that failed
   * first at that postcondition can still say whether each LATER site is broken or vacuous.
   */
  readonly relaxed?: { readonly outcome: MutationRunResult["outcome"]; readonly failedSites: readonly MutationFailedSite[] };
  /** #609: targeted proofs run for assertion sites this mutation left as a cascade. */
  readonly targeted?: readonly TargetedProof[];
}

/** sensitive: broke for the right reason · insensitive: still passed (vacuous) · cascade: broke elsewhere. */
export type MutationVerdict = "sensitive" | "insensitive" | "cascade" | "not-applied" | "error";
export type AssertionVerdict = MutationVerdict | "unpaired";

export interface AssertionProof {
  readonly site: string;
  readonly verdict: AssertionVerdict;
  /** The mutation that proved it sensitive. */
  readonly provedBy?: string;
  /** #609: the earlier postconditions a targeted proof weakened to reach a sensitive verdict. */
  readonly relaxedSites?: readonly string[];
  /** #609: why a targeted proof was refused, when the verdict stays a cascade. */
  readonly targetedRefusal?: string;
}

/** `step:<n>` · `step-request:<n>:<i>` · `end-state:<i>` — the names `metadata.mutationPairs` uses. */
export function assertionSiteKey(site: JourneyAssertionSite): string {
  if (site.where === "step") return `step:${site.step}`;
  if (site.where === "step-request") return `step-request:${site.step}:${site.checkIndex}`;
  return `end-state:${site.index}`;
}

const MUTATION_RE = /^(skip|block-write|stale-value|swap-param|truncate-param|guard-param):(.+)$/;
const SITE_RE = /^(?:step:[1-9][0-9]*|step-request:[1-9][0-9]*:(?:0|[1-9][0-9]*)|end-state:(?:0|[1-9][0-9]*))$/;

function flat(journey: Journey): RecordedStep[] {
  return journey.recording.pages.flatMap((p) => p.steps);
}

function mutation(kind: MutationKind, step: number): JourneyMutation {
  return { kind, step, id: `${kind}:${step}` };
}

/** The first (1-based) step whose action reads `name`, or null when no action does. */
function firstActionStep(journey: Journey, name: string): number | null {
  const i = flat(journey).findIndex((r) => actionRefs(r.step).includes(name));
  return i < 0 ? null : i + 1;
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
 * #579: the first reviewed `mutationValues` entry of parameter `name` that differs from the supplied
 * value — a value a human checked is valid for the page but wrong for this run — or null.
 */
function reviewedValue(journey: Journey, name: string, supplied: string): string | null {
  const declared = (journey.metadata.parameters ?? []).find((p) => p.name === name);
  return declared?.mutationValues?.find((v) => v !== supplied) ?? null;
}

/** #579: is `step` a `select` whose value is exactly the `{ var }` reference `name`? */
function selectsVar(step: Step, name: string): boolean {
  return step.kind === "select" && "var" in step.value && step.value.var === name;
}

function paramMutation(kind: "swap-param" | "truncate-param" | "guard-param", step: number, param: string): JourneyMutation {
  return { kind, step, id: `${kind}:${param}`, param };
}

/**
 * #580: the step sites that GUARD parameter `name`: assertions naming it that run before any action
 * reads it (or naming one no action reads, like an `expected_*` context check). They compare the
 * page with the run's input, so only a wrong INPUT can break them — a `guard-param` mutation.
 */
function guardSites(journey: Journey, sites: readonly JourneyAssertionSite[], name: string): StepAssertionSite[] {
  const action = firstActionStep(journey, name);
  return sites.filter((s): s is StepAssertionSite => s.where === "step" && siteRefs(s).includes(name) && (action === null || s.step < action));
}

type StepAssertionSite = Extract<JourneyAssertionSite, { readonly where: "step" }>;

/** A declared `swap-param:<name>` / `truncate-param:<name>`: a non-secret parameter an action reads. */
function paramMutationRef(journey: Journey, kind: "swap-param" | "truncate-param" | "guard-param", name: string, value: string): JourneyMutation {
  const declared = [...journey.metadata.params, ...(journey.metadata.parameters ?? []).map((p) => p.name)];
  if (!declared.includes(name)) throw new Error(`${JSON.stringify(value)}: ${JSON.stringify(name)} is not a declared parameter`);
  if (secretParamNames(journey).includes(name)) throw new Error(`${JSON.stringify(value)}: ${name} is a secret parameter — a secret is never mutated`);
  if (kind === "guard-param") {
    const first = guardSites(journey, journeyAssertions(journey), name)[0];
    if (first === undefined) throw new Error(`${JSON.stringify(value)}: no step assertion checks ${name} before an action reads it`);
    return paramMutation(kind, first.step, name);
  }
  const step = firstActionStep(journey, name);
  if (step === null) throw new Error(`${JSON.stringify(value)}: no step's action reads ${name} (a fill or a navigate URL)`);
  return paramMutation(kind, step, name);
}

/** Resolves a `mustFailWhen` (`skip:<n|anchor>`, …) against the Journey; throws a readable Error. */
function resolveMutationRef(journey: Journey, value: string): JourneyMutation {
  const m = MUTATION_RE.exec(value.trim());
  if (m === null) throw new Error(`${JSON.stringify(value)} is not a mutation — expected skip:<step>, block-write:<step> or stale-value:<step> (a step number or an anchor name), or swap-param:<param> / truncate-param:<param> / guard-param:<param>`);
  const ref = m[2]!;
  if (m[1] === "swap-param" || m[1] === "truncate-param" || m[1] === "guard-param") return paramMutationRef(journey, m[1], ref, value);
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

/**
 * #565: the variable a `{ var }` fill types, when it is not secret and some assertion names it — the
 * stale-value mutation of such a fill types an altered value (when the value is known) instead of "".
 */
function varFillRef(journey: Journey, step: Step, params: Readonly<Record<string, string>>): string | null {
  if (step.kind !== "fill" || !("var" in step.value)) return null;
  const name = step.value.var;
  if (secretParamNames(journey, params).includes(name)) return null;
  return journeyAssertions(journey).some((s) => siteRefs(s).includes(name)) ? name : null;
}

/** What a stale-value mutation types into fill `step`: an altered non-secret param value, else "". */
function staleValue(journey: Journey, step: Step, params: Readonly<Record<string, string>>): string {
  const name = varFillRef(journey, step, params);
  if (name === null) return "";
  const v = mutableParamValue(journey, name, params);
  return v === null ? "" : alteredValue(v);
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
export function mutationReplay(journey: Journey, m: JourneyMutation, opts: MutationReplayOptions = {}): MutationReplay {
  const index = m.step - 1;
  if (m.kind === "swap-param" || m.kind === "truncate-param" || m.kind === "guard-param") return paramReplay(journey, m, opts.params ?? {});
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
    target.step = { ...target.step, value: { redacted: false, value: staleValue(journey, step, opts.params ?? {}) } };
  }
  return { journey: copy };
}

/** #565: what `mutationReplay` takes — the lint options, and the params the proof runs with. */
export type MutationReplayOptions = JourneyLintOptions & { readonly params?: Readonly<Record<string, string>> };

/**
 * One mutated replay. `params`, when set, are the params the replay runs with in place of the
 * supplied ones (a param mutation; never a secret's value altered).
 */
export interface MutationReplay {
  readonly journey: Journey;
  readonly skipIndex?: number;
  readonly blockIndex?: number;
  readonly blockRequests?: readonly string[];
  readonly params?: Readonly<Record<string, string>>;
  /**
   * #579: instead of altering a parameter (a `select` cannot be swapped by rewriting params), pick a
   * DIFFERENT enabled live option at this 0-based flat step while avoiding the supplied value.
   */
  readonly swapSelectAtStep?: { readonly index: number; readonly avoid: string };
}

/**
 * #565: a param mutation's replay — the params with `m.param` swapped or truncated, and a copy of the
 * Journey whose assertions naming it are pinned to the SUPPLIED value. Throws when the parameter has
 * no mutable value (not supplied, blank, or secret).
 */
function paramReplay(journey: Journey, m: JourneyMutation, params: Readonly<Record<string, string>>): MutationReplay {
  const name = m.param ?? "";
  const index = m.step - 1;
  const target = flat(journey)[index]?.step;
  // #580: a guard mutation gives the WHOLE run the wrong input (reviewed, else generated) and pins
  // nothing: the guards compare the page with exactly that input, so they must refuse it.
  if (m.kind === "guard-param") {
    const supplied = mutableParamValue(journey, name, params);
    const wrong = supplied === null ? null : (reviewedValue(journey, name, supplied) ?? swappedValue(journey, name, params));
    if (wrong === null) throw new Error(`${m.id}: parameter ${name} has no value this proof may alter (not supplied, blank, too short, or secret)`);
    return { journey, params: { ...params, [name]: wrong } };
  }
  // #579: a reviewed `mutationValues` entry is the wrong value first, for any action (a fill, or a
  // select, where it names a real option); assertions stay pinned to the supplied value.
  const reviewedFrom = m.kind === "swap-param" ? mutableParamValue(journey, name, params) : null;
  const reviewed = reviewedFrom === null ? null : reviewedValue(journey, name, reviewedFrom);
  if (reviewedFrom !== null && reviewed !== null) return { journey: pinAssertionRefs(journey, name, reviewedFrom), params: { ...params, [name]: reviewed } };
  // #579: a `{ var }` parameter feeding a `select` cannot be swapped by rewriting params — the
  // replay picks another enabled live option instead, and the assertions keep expecting the supplied
  // value (params unchanged). The copy is cloned so a relaxed replay can weaken the step's expect.
  if (m.kind === "swap-param" && target !== undefined && selectsVar(target, name)) {
    const supplied = mutableParamValue(journey, name, params);
    if (supplied === null) throw new Error(`${m.id}: parameter ${name} has no value this proof may alter (not supplied, blank, too short, or secret)`);
    return { journey: structuredClone(journey), swapSelectAtStep: { index, avoid: supplied } };
  }
  const supplied = mutableParamValue(journey, name, params);
  const altered = m.kind === "swap-param" ? swappedValue(journey, name, params) : truncatedValue(journey, name, params);
  if (supplied === null || altered === null) throw new Error(`${m.id}: parameter ${name} has no value this proof may alter (not supplied, blank, too short, or secret)`);
  return { journey: pinAssertionRefs(journey, name, supplied), params: { ...params, [name]: altered } };
}

/** #567: the schema-valid weak postcondition a relaxed mutated step keeps in place of its own
 * `expect` — the Recording schema REQUIRES `expect` for fill/click/etc, so it cannot be dropped. A
 * step with a `target` gets `visible` on its OWN target (the per-step vacuous claim #400 names: it
 * holds before AND after the action, so it cannot prove the mutated value); a target-less step kind
 * (e.g. `navigate`) gets the explicit no-claim `urlIncludes ""` used elsewhere. */
function relaxedExpect(step: Step): Assertion {
  if ("target" in step && step.target !== undefined) return { kind: "visible", target: step.target };
  return { kind: "urlIncludes", text: "" };
}

/**
 * #554: the same mutation with the mutated step's OWN postcondition relaxed. `skip` skips the step
 * in place without turning its `expect` into an assert step; `block-write` and `stale-value` apply
 * the same action mutation but replace the step's `expect` with a schema-valid weak one (#567) and
 * drop `waitFor` (its `expectRequests` stay).
 * The input Journey is never modified and no step is removed, so it replays with the same indices.
 */
export function relaxedMutationReplay(journey: Journey, m: JourneyMutation, opts: MutationReplayOptions = {}): MutationReplay {
  const index = m.step - 1;
  if (m.kind === "skip") return { journey, skipIndex: index };
  if (m.kind === "swap-param" || m.kind === "truncate-param" || m.kind === "guard-param") {
    // #565: the same altered params; the step that first reads the parameter keeps a weak claim.
    const how = paramReplay(journey, m, opts.params ?? {});
    // A guard mutation replays the input Journey itself, so it is cloned before the claim is weakened.
    const copy = how.journey === journey ? structuredClone(journey) : how.journey;
    const target = flat(copy)[index];
    if (target !== undefined && "expect" in target.step) {
      const step: Record<string, unknown> = { ...target.step, expect: relaxedExpect(target.step) };
      delete step.waitFor;
      target.step = step as Step;
    }
    return { ...how, journey: copy };
  }
  if (m.kind === "block-write") {
    const requests = journeyWriteSteps(journey, opts).find((w) => w.step === m.step)?.requests ?? [];
    const copy = structuredClone(journey);
    const target = flat(copy)[index]!;
    const step: Record<string, unknown> = { ...target.step, expect: relaxedExpect(target.step) };
    delete step.waitFor;
    target.step = step as Step;
    return { journey: copy, blockIndex: index, blockRequests: [...requests] };
  }
  const copy = structuredClone(journey);
  const target = flat(copy)[index]!;
  if (target.step.kind === "fill") {
    const step: Record<string, unknown> = {
      ...target.step,
      value: { redacted: false, value: staleValue(journey, target.step, opts.params ?? {}) },
      expect: relaxedExpect(target.step),
    };
    delete step.waitFor;
    target.step = step as Step;
  }
  return { journey: copy };
}

/**
 * #609 — how many earlier postconditions a targeted proof may weaken before it stops. A proof that
 * needs more than this is not evidence about the target; it is a cascade the run could not untangle.
 */
export const MAX_TARGETED_RELAXATIONS = 4;

/** #609 — the site-key form of a failed site, for a refusal that names where the replay stopped. */
function failedSiteKey(f: MutationFailedSite): string {
  if (f.where === "step") return `step:${f.step}`;
  if (f.where === "step-request") return `step-request:${f.step}:${f.checkIndex}`;
  if (f.where === "end-state") return `end-state:${f.index}`;
  return "unevaluable";
}

/**
 * #609 — `relaxedMutationReplay` plus a weakened postcondition at every earlier step in
 * `relaxedSiteKeys` (only `step:<n>`): a step's `expect` becomes `relaxedExpect`, an `assert` step's
 * `check` becomes the no-claim `urlIncludes ""`, and each loses `waitFor`. The target assertion is
 * never relaxed, the input Journey is never modified, and no step is removed (indices hold).
 */
export function targetedMutationReplay(
  journey: Journey,
  m: JourneyMutation,
  targetSiteKey: string,
  relaxedSiteKeys: readonly string[],
  opts: MutationReplayOptions = {},
): MutationReplay {
  if (relaxedSiteKeys.includes(targetSiteKey)) throw new Error(`${targetSiteKey} is the target assertion — a targeted proof never relaxes it`);
  const base = relaxedMutationReplay(journey, m, opts);
  if (relaxedSiteKeys.length === 0) return base;
  return { ...base, journey: relaxStepSites(journey, base.journey, relaxedSiteKeys) };
}

/**
 * #609 — the CONTROL for a targeted proof: the same weakened postconditions (the relaxed sites and the
 * mutated step's own claim, as the targeted replay weakens them) with NO mutation — the supplied
 * params, nothing skipped, blocked or swapped. It must pass: when relaxing the earlier checks breaks
 * the target on its own (e.g. a removed `waitFor` was the gate), the target's failure is not
 * evidence about the mutation.
 */
export function targetedControlReplay(journey: Journey, m: JourneyMutation, relaxedSiteKeys: readonly string[]): MutationReplay {
  const own = flat(journey)[m.step - 1]?.step;
  const ownKey = own !== undefined && (own.kind === "assert" || "expect" in own) ? [`step:${m.step}`] : [];
  return { journey: relaxStepSites(journey, journey, [...new Set([...ownKey, ...relaxedSiteKeys])]) };
}

/** #609: a clone of `from` with each `step:<n>` postcondition in `keys` weakened (sites read from `journey`). */
function relaxStepSites(journey: Journey, from: Journey, keys: readonly string[]): Journey {
  const byKey = new Map(journeyAssertions(journey).map((s) => [assertionSiteKey(s), s]));
  const copy = structuredClone(from);
  const steps = flat(copy);
  for (const key of keys) {
    const match = /^step:([1-9][0-9]*)$/.exec(key);
    if (match === null) throw new Error(`${key} is not a step assertion site — a targeted proof only relaxes step:<n>`);
    const site = byKey.get(key);
    if (site !== undefined && site.where === "step" && site.field === "resume") throw new Error(`${key} is a resume assertion — a targeted proof never relaxes it`);
    const recorded = steps[Number(match[1]) - 1];
    if (recorded === undefined) throw new Error(`journey '${journey.metadata.id}' has no step ${match[1]} to relax`);
    const step: Record<string, unknown> = { ...recorded.step };
    if (recorded.step.kind === "assert") step.check = { kind: "urlIncludes", text: "" };
    else if ("expect" in recorded.step) step.expect = relaxedExpect(recorded.step);
    else throw new Error(`${key} has no page postcondition to relax`);
    delete step.waitFor;
    recorded.step = step as Step;
  }
  return copy;
}

/**
 * #609 — the next earlier postcondition a targeted proof should weaken to reach `targetSiteKey`, or
 * `{refuse}` when there is no defensible one, or null when the target is no longer a cascade. A
 * relaxable failure is the FIRST failed site, at a `step` with `postcondition: true`, at or after the
 * mutated step, before the target, paired with `m` (its own sensitivity evidence), not already
 * relaxed, and within `MAX_TARGETED_RELAXATIONS`.
 */
export function nextTargetedRelaxation(
  journey: Journey,
  plan: MutationPlan,
  m: JourneyMutation,
  targetSiteKey: string,
  result: { readonly outcome: MutationRunResult["outcome"]; readonly failedSites: readonly MutationFailedSite[] },
  relaxedSoFar: readonly string[],
): { readonly relax: string } | { readonly refuse: string } | null {
  const target = journeyAssertions(journey).find((s) => assertionSiteKey(s) === targetSiteKey);
  if (target === undefined) return { refuse: `${targetSiteKey} is not an assertion site of this Journey` };
  if (classifyMutation(target, m, result) !== "cascade") return null;
  const first = result.failedSites[0];
  if (first === undefined) return { refuse: "no failed site to relax" };
  if (first.where === "unevaluable") return { refuse: "unevaluable end state" };
  if (first.where !== "step") return { refuse: `${failedSiteKey(first)} is not a step postcondition` };
  const key = `step:${first.step}`;
  if (!first.postcondition) return { refuse: `${key} action failed (not a postcondition)` };
  if (first.step < m.step) return { refuse: "failure before the mutated step" };
  const step = flat(journey)[first.step - 1]?.step;
  if (step === undefined) return { refuse: `${key} does not exist` };
  if (step.kind === "handback") return { refuse: `${key} is a resume assertion (not a relaxable page postcondition)` };
  if (target.where === "step" && target.step <= first.step) return { refuse: `${key} is not before the target ${targetSiteKey}` };
  if (!plan.pairs.some((p) => p.site === key && p.mutation === m.id)) return { refuse: `${key} is not paired with ${m.id}` };
  if (relaxedSoFar.includes(key)) return { refuse: `${key} is already relaxed` };
  if (relaxedSoFar.length >= MAX_TARGETED_RELAXATIONS) return { refuse: `relaxation bound ${MAX_TARGETED_RELAXATIONS} reached` };
  return { relax: key };
}

/**
 * #609 — drive a targeted proof: from `initial` (its `relaxed` result when the mutated step's own
 * postcondition failed first, as `classifyMutation` reads it), relax the earliest defensible blocking
 * postcondition and replay until the target is no longer a cascade, a relaxation is refused, or the
 * bound is reached. The target's own assertion is never relaxed. A targeted failure at the target
 * counts only after an unmutated control replay with the same relaxations passes.
 */
export async function runTargetedProof(
  journey: Journey,
  plan: MutationPlan,
  m: JourneyMutation,
  target: JourneyAssertionSite,
  initial: MutationRunResult,
  replay: (
    describe: (journey: Journey) => MutationReplay,
    kind: "targeted" | "control",
  ) => Promise<{ readonly outcome: MutationRunResult["outcome"]; readonly failedSites: readonly MutationFailedSite[] }>,
  opts: MutationReplayOptions = {},
): Promise<TargetedProof> {
  const site = assertionSiteKey(target);
  const relaxedSites: string[] = [];
  const relaxedFirst =
    initial.relaxed !== undefined &&
    initial.failedSites.some((f) => f.where === "step" && f.step === m.step && f.postcondition) &&
    !(target.where === "step" && target.step === m.step);
  let run = relaxedFirst
    ? { outcome: initial.relaxed!.outcome, failedSites: initial.relaxed!.failedSites }
    : { outcome: initial.outcome, failedSites: initial.failedSites };
  for (;;) {
    const next = nextTargetedRelaxation(journey, plan, m, site, run, relaxedSites);
    if (next === null) break;
    if ("refuse" in next) return { site, relaxedSites, outcome: run.outcome, failedSites: run.failedSites, refused: next.refuse };
    relaxedSites.push(next.relax);
    // The replay is described per Journey it is given (the stored one moved onto the environment).
    const relaxedNow = [...relaxedSites];
    run = await replay((j) => targetedMutationReplay(j, m, site, relaxedNow, opts), "targeted");
  }
  if (relaxedSites.length > 0 && classifyMutationPlain(target, m, run) === "sensitive") {
    // A failure counts only when the same relaxations WITHOUT the mutation still pass.
    const control = await replay((j) => targetedControlReplay(j, m, relaxedSites), "control");
    if (control.outcome !== "passed") {
      return {
        site,
        relaxedSites,
        outcome: run.outcome,
        failedSites: run.failedSites,
        control: control.outcome,
        refused: `the unmutated control replay with ${relaxedSites.join(", ")} relaxed did not pass (${control.outcome})`,
      };
    }
    return { site, relaxedSites, outcome: run.outcome, failedSites: run.failedSites, control: control.outcome };
  }
  return { site, relaxedSites, outcome: run.outcome, failedSites: run.failedSites };
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
  return plan.pairs.some((p) => p.mutation === m.id && p.site !== own);
}

/**
 * #609 — classify on the plain rules, then, when that is a `cascade` and `result.targeted` carries a
 * targeted proof for this site, classify on that proof's final run (no further relaxation). A
 * refused targeted attempt still cascades; a site is sensitive only when the target itself failed.
 */
export function classifyMutation(site: JourneyAssertionSite, m: JourneyMutation, result: MutationRunResult): MutationVerdict {
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
function classifyMutationPlain(site: JourneyAssertionSite, m: JourneyMutation, result: MutationRunResult): MutationVerdict {
  // #554: the mutated step's own postcondition failed, so a later site is judged on the relaxed
  // replay (same rules, no further relaxed level). The step's own step site keeps the original
  // result, so its own failure stays the sensitive verdict.
  if (
    result.relaxed !== undefined &&
    result.failedSites.some((f) => f.where === "step" && f.step === m.step && f.postcondition) &&
    !(site.where === "step" && site.step === m.step)
  ) {
    return classifyMutationPlain(site, m, { outcome: result.relaxed.outcome, failedSites: result.relaxed.failedSites });
  }
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
 * #402/#609: every assertion's verdict over its paired mutations — sensitive when ANY paired
 * mutation broke it for the right reason (`provedBy` the first), else insensitive when one passed,
 * else cascade / not-applied / error; `unpaired` when no mutation is paired with it. A sensitive
 * verdict reached by a targeted proof records its relaxed sites; a cascade that a targeted attempt
 * refused records why (#609).
 */
export function judgeAssertions(journey: Journey, plan: MutationPlan, results: ReadonlyMap<string, MutationRunResult>): AssertionProof[] {
  const proofFor = (m: JourneyMutation, key: string): TargetedProof | undefined => results.get(m.id)?.targeted?.find((t) => t.site === key);
  return journeyAssertions(journey).map((site) => {
    const key = assertionSiteKey(site);
    const paired = plan.mutations.filter((m) => plan.pairs.some((p) => p.site === key && p.mutation === m.id));
    if (paired.length === 0) return { site: key, verdict: "unpaired" };
    const verdicts = paired.map((m) => ({ m, v: classifyMutation(site, m, results.get(m.id) ?? { outcome: "error", failedSites: [] }) }));
    for (const v of PRECEDENCE) {
      const first = verdicts.find((x) => x.v === v);
      if (first === undefined) continue;
      if (v === "sensitive") {
        const proof = proofFor(first.m, key);
        return proof !== undefined && proof.refused === undefined
          ? { site: key, verdict: v, provedBy: first.m.id, relaxedSites: proof.relaxedSites }
          : { site: key, verdict: v, provedBy: first.m.id };
      }
      if (v === "cascade") {
        const refusal = paired.map((m) => proofFor(m, key)).find((t) => t !== undefined && t.refused !== undefined);
        if (refusal !== undefined) return { site: key, verdict: v, targetedRefusal: refusal.refused };
      }
      return { site: key, verdict: v };
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
  if (paired.length === 0) return { verdict: "inconclusive", reason: "no assertion is paired with a mutation (no write step, no checked fill, no checked parameter, no mutationPairs)" };
  if (paired.some((a) => a.verdict === "insensitive")) return { verdict: "insensitive" };
  if (paired.every((a) => a.verdict === "sensitive")) return { verdict: "proven" };
  const refusals = input.assertions.map((a) => a.targetedRefusal).filter((r): r is string => r !== undefined);
  if (refusals.length > 0) {
    return { verdict: "inconclusive", reason: `some paired assertions were neither proven nor shown vacuous (cascade, not-applied or error); a targeted proof was refused: ${refusals[0]}` };
  }
  return { verdict: "inconclusive", reason: "some paired assertions were neither proven nor shown vacuous (cascade, not-applied or error)" };
}
