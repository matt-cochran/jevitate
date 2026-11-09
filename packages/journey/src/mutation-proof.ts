import type { Assertion, NetworkCheck, OutcomeWait, RecordedStep, Step } from "@jevitate/recording";
import { canonicalJson, expandBraces, matchGlob } from "@jevitate/domain";
import { classifyMutation, classifyMutationPlain, evaluatedOwnRequestFailure, type MutationKindSchema } from "@jevitate/adjudicator";
import { WAIT_FOR_STALL_MS } from "@jevitate/recording";
import type { Journey, JourneyTargetedProofPlan } from "./journey.js";
import { isNoClaimExpect, journeyAssertions, type JourneyAssertionSite } from "./assertions.js";
import { journeyMutationSteps, journeyWriteSteps, type JourneyLintOptions } from "./lint.js";
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
 *  - `skip:<n>` — an effect action is left out (its own `expect`, when it has one, is still
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
// The evidence record's kinds (@jevitate/adjudicator) are exactly these: a kind added on one side fails to build.
type SameKinds<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
const _kindsMirrored: SameKinds<MutationKind, import("zod").infer<typeof MutationKindSchema>> = true;
void _kindsMirrored;

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
  | { readonly where: "step-request"; readonly step: number; readonly checkIndex: number; readonly evaluated?: true }
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
  /** #616: a DECLARED plan chose this proof's relaxations, not the automatic bound search. */
  readonly declared?: true;
  /** #785: what the failed control replay did, against the base replay. Set only when a control ran and did not pass. */
  readonly controlDiagnostics?: TargetedControlDiagnostics;
}

/**
 * #785: what one replay did, in counts and booleans only: never a storage value, token, URL or page
 * text. Storage counts are `null` when the page could not be read at that moment.
 */
interface ReplayDiagnostics {
  readonly stepsTotal: number;
  readonly stepsCompleted: number;
  readonly sessionsOpened: number;
  /** The session's page or browser context changed during the replay. */
  readonly pageReplaced: boolean;
  /** First-party or not, the page's non-GET/HEAD/OPTIONS requests: sent, answered, failed (aborted), neither. */
  readonly writesSent: number;
  readonly writesAnswered: number;
  readonly writesAborted: number;
  readonly writesUnfinished: number;
  /** Key and cookie counts as the last step ended, before the end state's reload. */
  readonly storageBeforeEndState: StorageCounts | null;
  /** Key and cookie counts on the final page, after the end state's reload. */
  readonly storageAfterEndState: StorageCounts | null;
  /** How each wait kept on a relaxed site ended (`RelaxedSiteWait`). */
  readonly relaxedWaits: readonly { readonly site: string; readonly ending: RelaxedWaitEnding; readonly waitedMs: number }[];
}

interface StorageCounts {
  readonly sessionStorageKeys: number;
  readonly localStorageKeys: number;
  readonly cookies: number;
}

/** `unresolved`: the assertion names a value only the replay holds (an `extract` output, `setup.x`), so it could not be waited on. */
type RelaxedWaitEnding = "held" | "timeout" | "hang" | "unresolved" | "not-run";

interface TargetedControlDiagnostics {
  /** Where the control failed, as site keys. */
  readonly failedSites: readonly string[];
  readonly control: ReplayDiagnostics;
  /** The Journey replayed as recorded, for comparison. */
  readonly base?: ReplayDiagnostics;
  /** Both replays opened their session with the same options (false: a different browser context). */
  readonly contextOptionsMatchBase?: boolean;
}

/** What a targeted proof's replay reports back; `diagnostics` only from a control that did not pass. */
interface TargetedReplayRun {
  readonly outcome: MutationRunResult["outcome"];
  readonly failedSites: readonly MutationFailedSite[];
  readonly diagnostics?: TargetedControlDiagnostics;
  /** Sites this replay failed at sooner than the base replay passed them (`sitesReachedEarly`), so its failure is no evidence. */
  readonly waitsCut?: readonly string[];
  /** Ms from the mutated step's start to when each step began, 0-based by flat step: when this replay got to that site. */
  readonly arrivedMs?: readonly (number | undefined)[];
  /** Ms from the mutated step's start to when it began reading its end state. */
  readonly endStateReachedMs?: number;
  /** How far apart a mutated replay and its control may reach a site and still be compared (`paceMarginOf`). */
  readonly marginMs?: number;
  /** How the fresh unmutated replay this run was checked against ended (`MutationRunResult.control`). */
  readonly control?: MutationRunResult["outcome"];
}

/** A mutated replay: it passed, failed (where), was not applied (nothing to mutate), or errored. */
export interface MutationRunResult {
  readonly outcome: "passed" | "failed" | "not-applied" | "error";
  readonly failedSites: readonly MutationFailedSite[];
  /**
   * Sites this replay failed at sooner than the base replay passed them (`sitesReachedEarly`). Its
   * waiting did not match the base's, so no replay is its control and its failure is no evidence.
   */
  readonly waitsCut?: readonly string[];
  /**
   * #554 — the same mutation replayed with the mutated step's own postcondition relaxed (its action
   * still skipped/blocked/emptied, but its `expect`/`waitFor` left out), so a replay that failed
   * first at that postcondition can still say whether each LATER site is broken or vacuous.
   */
  readonly relaxed?: { readonly outcome: MutationRunResult["outcome"]; readonly failedSites: readonly MutationFailedSite[]; readonly waitsCut?: readonly string[]; readonly atBaseTime?: BaseTimedRun };
  /** #609: targeted proofs run for assertion sites this mutation left as a cascade. */
  readonly targeted?: readonly TargetedProof[];
  /** How the matched unmutated replay ended, when a sensitive reading needed one (`sitesNeedingControl`, `siblingDisagreements`). */
  readonly control?: MutationRunResult["outcome"];
  /** What that replay did against the base, when it did not pass. */
  readonly controlDiagnostics?: TargetedControlDiagnostics;
  /**
   * The matched control failed at the same site, so the hold itself may be what broke it: the same
   * mutated replay, held only as long as the base took. A pass there shows the claim holds without the mutation.
   */
  readonly atBaseTime?: BaseTimedRun;
  /** How this mutation's one re-run ended, when a sibling mutation of its step passed a site it failed (`siblingDisagreements`). */
  readonly rerun?: MutationRunResult["outcome"];
}

/** `MutationRunResult.atBaseTime`. */
export interface BaseTimedRun {
  readonly outcome: MutationRunResult["outcome"];
  readonly failedSites: readonly MutationFailedSite[];
}

/** sensitive: broke for the right reason · insensitive: still passed (vacuous) · cascade: broke elsewhere. */
export type MutationVerdict = "sensitive" | "insensitive" | "cascade" | "not-applied" | "error";
export type AssertionVerdict = MutationVerdict | "unpaired";

export interface AssertionProof {
  readonly site: string;
  /** An unpaired own request or network/persistence end-state is a required unresolved obligation. */
  readonly required?: true;
  readonly verdict: AssertionVerdict;
  /** The mutation that proved it sensitive. */
  readonly provedBy?: string;
  /** #609: the earlier postconditions a targeted proof weakened to reach a sensitive verdict. */
  readonly relaxedSites?: readonly string[];
  /** #609: why a targeted proof was refused, when the verdict stays a cascade. */
  readonly targetedRefusal?: string;
  /** Independent propositions: a UI action witness cannot discharge value/data sensitivity. */
  readonly obligations?: readonly {
    readonly kind: "data" | "action";
    readonly verdict: MutationVerdict;
    readonly provedBy?: string;
    readonly relaxedSites?: readonly string[];
    readonly targetedRefusal?: string;
  }[];
}

/** `step:<n>` · `step-request:<n>:<i>` · `end-state:<i>` — the names `metadata.mutationPairs` uses. */
export function assertionSiteKey(site: JourneyAssertionSite): string {
  if (site.where === "step") return `step:${site.step}`;
  if (site.where === "step-request") return `step-request:${site.step}:${site.checkIndex}`;
  return `end-state:${site.index}`;
}

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
 * #616: what is wrong with `metadata.targetedProofs` — an unknown assertion site, an unresolvable
 * `mustFailWhen`, or a `relax` entry that is not an earlier page/request defense (a
 * resume/handback assertion, a step with no page postcondition, the target itself, a step at or
 * after a step target, a duplicate, or a missing step). Empty when every plan resolves.
 */
export function targetedProofPlanIssues(journey: Journey): { readonly index: number; readonly field: "check" | "mustFailWhen" | "relax"; readonly message: string }[] {
  const plans = journey.metadata.targetedProofs ?? [];
  if (plans.length === 0) return [];
  const sites = new Set(journeyAssertions(journey).map(assertionSiteKey));
  const steps = flat(journey);
  const out: { index: number; field: "check" | "mustFailWhen" | "relax"; message: string }[] = [];
  const seen = new Set<string>();
  plans.forEach((plan, index) => {
    const key = `${plan.check}\u0000${plan.mustFailWhen}`;
    if (seen.has(key)) out.push({ index, field: "check", message: `targetedProofs: duplicate plan for ${plan.check} and ${plan.mustFailWhen}` });
    seen.add(key);
    if (!SITE_RE.test(plan.check)) {
      out.push({ index, field: "check", message: `targetedProofs: ${JSON.stringify(plan.check)} is not an assertion site — expected step:<n>, step-request:<n>:<i> or end-state:<i>` });
    } else if (!sites.has(plan.check)) {
      out.push({ index, field: "check", message: `targetedProofs: the Journey has no assertion at ${plan.check}` });
    }
    let mutated: JourneyMutation | undefined;
    try {
      mutated = resolveMutationRef(journey, plan.mustFailWhen);
    } catch (err) {
      out.push({ index, field: "mustFailWhen", message: `targetedProofs: ${err instanceof Error ? err.message : String(err)}` });
    }
    const check = /^(?:step|step-request):([1-9][0-9]*)(?::[0-9]+)?$/.exec(plan.check);
    const targetStep = check === null ? null : Number(check[1]);
    const relaxed = new Set<string>();
    for (const entry of plan.relax) {
      const request = /^step-request:([1-9][0-9]*):([0-9]+)$/.exec(entry);
      if (!/^step:[1-9][0-9]*$/.test(entry) && request === null) {
        out.push({ index, field: "relax", message: `targetedProofs: ${JSON.stringify(entry)} is not a step assertion site — expected step:<n> or step-request:<n>:<i>` });
        continue;
      }
      if (relaxed.has(entry)) {
        out.push({ index, field: "relax", message: `targetedProofs: ${entry} is relaxed twice` });
        continue;
      }
      relaxed.add(entry);
      const n = Number(request?.[1] ?? entry.slice("step:".length));
      const recorded = steps[n - 1];
      if (recorded === undefined) {
        out.push({ index, field: "relax", message: `targetedProofs: the Journey has no step ${n}` });
        continue;
      }
      if (entry === plan.check) {
        out.push({ index, field: "relax", message: `targetedProofs: ${entry} is the target assertion — a declared proof never relaxes it` });
        continue;
      }
      if (targetStep !== null && n > targetStep) {
        out.push({ index, field: "relax", message: `targetedProofs: ${entry} is not before the target step:${targetStep}` });
        continue;
      }
      if (targetStep === n && request !== null) {
        out.push({ index, field: "relax", message: `targetedProofs: ${entry} is not before the target ${plan.check}` });
        continue;
      }
      if (recorded.step.kind === "handback") {
        out.push({ index, field: "relax", message: `targetedProofs: ${entry} is a resume assertion — a declared proof never relaxes it` });
        continue;
      }
      if (request !== null && !sites.has(entry)) {
        out.push({ index, field: "relax", message: `targetedProofs: the Journey has no assertion at ${entry}` });
        continue;
      }
      if (request === null && recorded.step.kind !== "assert" && !("expect" in recorded.step)) {
        out.push({ index, field: "relax", message: `targetedProofs: ${entry} has no page postcondition to relax` });
        continue;
      }
      // #616: a check before the mutation takes effect cannot catch it, so it is never a defense to relax.
      if (mutated !== undefined && n < mutated.step) {
        out.push({ index, field: "relax", message: `targetedProofs: ${entry} is before the mutated step ${mutated.step} (${plan.mustFailWhen})` });
      }
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

/** Exact symbolic outcome ownership; display metadata never locates a target. */
function outcomeIdentity(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(outcomeIdentity);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !["display", "tflowId", "testIdAttr"].includes(key)).map(([key, v]) => [key, outcomeIdentity(v)]));
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
 * #409: a waited claim on the mutated step itself waits a bounded time — the job was skipped or its
 * writes blocked, so the outcome must be absent; waiting out a long `maxMs` would only make the proof
 * slow. It still FAILS (times out, or hangs on its progress signal), at that step, as a postcondition:
 * the sensitive verdict. This is the cap before pacing: `pacedReplay` then sets the wait every replay
 * of the proof uses, the larger of this and what the base took (`pacedWait`).
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

/** #565: what `mutationReplay` takes — the lint options, and the params the proof runs with. */
export type MutationReplayOptions = JourneyLintOptions & { readonly params?: Readonly<Record<string, string>> };

/**
 * One mutated replay. `params`, when set, are the params the replay runs with in place of the
 * supplied ones (a param mutation; never a secret's value altered).
 */
export interface MutationReplay {
  readonly journey: Journey;
  /** #708: private verifier mask; stored checks/indices and request capture remain unchanged. */
  readonly relaxedStepRequests?: readonly string[];
  /** #785: the waiting each relaxed site did; the verifier runs them as the step ends and ignores how they end. */
  readonly relaxedSiteWaits?: readonly RelaxedSiteWait[];
  readonly skipIndex?: number;
  readonly blockIndex?: number;
  readonly blockRequests?: readonly string[];
  /** Observed or declared method/path matchers; not fabricated recorded request lines. */
  readonly blockMatchers?: readonly { readonly method: string; readonly pathGlob: string; readonly literal?: true }[];
  readonly params?: Readonly<Record<string, string>>;
  /**
   * #579: instead of altering a parameter (a `select` cannot be swapped by rewriting params), pick a
   * DIFFERENT enabled live option at this 0-based flat step while avoiding the supplied value.
   */
  readonly swapSelectAtStep?: { readonly index: number; readonly avoid: string };
}

/**
 * #785: an assertion also WAITS. A relaxed site must stop being able to fail the replay and go on
 * waiting as it did, or the replay moves on before what it was waiting for has landed (a reload that
 * aborts a write still in flight), and the failure that follows is timing, not evidence.
 *
 * Bounded and never fatal: a `page` wait polls the site's original assertion (its own `waitFor`, else
 * the interpreter's postcondition bound), a `response` wait holds until the step's matching requests
 * are answered (its `responseTimeoutMs`, else the run's). Neither can turn a failure into a pass: only
 * the unrelaxed assertions judge the replay. `pacedReplay` bounds these waits as it does a judged one.
 */
type RelaxedSiteWait =
  | { readonly kind: "page"; readonly site: string; readonly step: number; readonly assertion: Assertion; readonly wait?: OutcomeWait }
  | { readonly kind: "response"; readonly site: string; readonly step: number; readonly check: NetworkCheck; readonly responseTimeoutMs?: number };

/** The page wait of `step`'s own claim, read BEFORE it is weakened; null for a step with no claim. */
function pageSiteWait(step: Step, n: number): RelaxedSiteWait | null {
  const assertion = step.kind === "assert" ? step.check : "expect" in step ? step.expect : null;
  if (assertion === null) return null;
  const wait = "waitFor" in step ? step.waitFor : undefined;
  return wait === undefined ? { kind: "page", site: `step:${n}`, step: n, assertion } : { kind: "page", site: `step:${n}`, step: n, assertion, wait };
}

/** #785: the waits of `keys`, read from `from` before its sites are weakened. A step the replay leaves out waits for nothing. */
function relaxedSiteWaits(from: Journey, keys: readonly string[], skipIndex?: number): RelaxedSiteWait[] {
  const steps = flat(from);
  return keys.flatMap((key): RelaxedSiteWait[] => {
    const match = /^(?:step|step-request):([1-9][0-9]*)(?::([0-9]+))?$/.exec(key);
    if (match === null) return [];
    const n = Number(match[1]);
    const recorded = steps[n - 1];
    if (recorded === undefined || n - 1 === skipIndex) return [];
    if (match[2] === undefined) {
      const page = pageSiteWait(recorded.step, n);
      return page === null ? [] : [page];
    }
    const check = recorded.expectRequests?.[Number(match[2])];
    if (check === undefined) return [];
    return [{ kind: "response", site: key, step: n, check, ...(recorded.responseTimeoutMs === undefined ? {} : { responseTimeoutMs: recorded.responseTimeoutMs }) }];
  });
}

/**
 * How the base replay paced itself: ms from its first step's start to each step's end, 0-based by flat
 * step. Measured, never recorded, so it is what this app took just now. Empty: nothing was measured,
 * and a replay is held to no pace.
 */
export interface ReplayPace {
  readonly stepEndMs: readonly number[];
  /** When its end state's checks ended: they settle before they read, which no step's end shows. */
  readonly endStateMs?: number;
  /**
   * When each step's own claim had held, 0-based by flat step. A step goes on after that (its request
   * checks wait on their responses), so a claim site is compared with this, not with the step's end.
   */
  readonly claimHeldMs?: readonly (number | undefined)[];
}

/** A fixed second plus a quarter of the step, for what a job's time may vary by between replays. */
function paceMarginMs(stepMs: number): number {
  return PACE_MARGIN_MS + stepMs / 4;
}

/** The margin of replays of `m`'s step: how far apart a mutated replay and its control may reach a site. */
export function paceMarginOf(pace: ReplayPace, m: JourneyMutation): number {
  return paceMarginMs(baseStepMs(pace, m.step - 1));
}

/** The largest margin a step that can legally take `stepMs` could get. */
export function paceMarginBoundMs(stepMs: number): number {
  return paceMarginMs(stepMs);
}

/** A wait's `maxMs`, a whole number as the schema requires, past what the base took at that step. */
function pastBaseMs(stepMs: number): number {
  return Math.ceil(stepMs + paceMarginMs(stepMs));
}

const PACE_MARGIN_MS = 1_000;
/** What a claim with no `waitFor` polls for (`checkAssertion`). */
const POSTCONDITION_BOUND_MS = 5_000;

/** How long the base replay spent on 0-based step `index` alone. */
function baseStepMs(pace: ReplayPace, index: number): number {
  const end = pace.stepEndMs[index];
  return end === undefined ? 0 : end - (index === 0 ? 0 : (pace.stepEndMs[index - 1] ?? 0));
}

/** How long the base replay spent on 0-based step `index` up to the moment its own claim held (`baseStepMs` when not measured). */
function baseClaimMs(pace: ReplayPace, index: number): number {
  const held = pace.claimHeldMs?.[index];
  return held === undefined ? baseStepMs(pace, index) : held - (index === 0 ? 0 : (pace.stepEndMs[index - 1] ?? 0));
}

/** How long the base replay took from the start of `m`'s step to the end of 0-based step `index`. */
function baseSinceMutation(pace: ReplayPace, m: JourneyMutation, index: number): number | undefined {
  const end = pace.stepEndMs[index];
  if (end === undefined || index < m.step - 1) return undefined;
  return end - (m.step === 1 ? 0 : (pace.stepEndMs[m.step - 2] ?? 0));
}

/**
 * The soonest a replay of `m` may leave 0-based step `index`, in ms from `m`'s step's start: when the
 * base replay left it, plus the margin. A skip or a blocked write takes that step's waiting with it,
 * so with no floor a later site is reached sooner than the base reached it, and a job from an earlier
 * step reads as sensitivity. Undefined before the mutated step, which runs as the base did.
 */
export function paceFloorMs(pace: ReplayPace, m: JourneyMutation, index: number, withMargin = true): number | undefined {
  const since = baseSinceMutation(pace, m, index);
  return since === undefined ? undefined : since + (withMargin ? paceMarginOf(pace, m) : 0);
}

/** How long the base replay took from the start of `m`'s step to reading its end state. */
function baseEndStateSinceMutation(pace: ReplayPace, m: JourneyMutation): number | undefined {
  const last = baseSinceMutation(pace, m, pace.stepEndMs.length - 1);
  if (last === undefined) return undefined;
  return pace.endStateMs === undefined ? last : pace.endStateMs - (m.step === 1 ? 0 : (pace.stepEndMs[m.step - 2] ?? 0));
}

/** The soonest a replay of `m` may read its end state, in ms from `m`'s step's start (`paceFloorMs`). */
export function paceEndStateFloorMs(pace: ReplayPace, m: JourneyMutation, withMargin = true): number | undefined {
  const since = baseEndStateSinceMutation(pace, m);
  return since === undefined ? undefined : since + (withMargin ? paceMarginOf(pace, m) : 0);
}

/** How long the base replay took to reach `m`'s step: what a replay that stopped before that step is held to, on top of the tail. */
export function paceBeforeMutationMs(pace: ReplayPace, m: JourneyMutation): number {
  return m.step === 1 ? 0 : (pace.stepEndMs[m.step - 2] ?? 0);
}

/**
 * The floor of the base replay's end: a replay that sent a write and stopped sooner holds its page
 * open until then, so what it started lands before its restore and not inside the next replay.
 */
export function paceTailMs(pace: ReplayPace, m: JourneyMutation): number | undefined {
  return paceEndStateFloorMs(pace, m);
}

/** A wait that cannot end before the base replay's own did: no progress signal to end it, and a bound past what the base took. */
function pacedWait(wait: OutcomeWait, stepMs: number): OutcomeWait {
  const { progress: _progress, ...rest } = wait;
  return { ...rest, maxMs: Math.min(wait.maxMs, Math.max((wait.stallMs ?? WAIT_FOR_STALL_MS) + MUTATION_WAIT_MARGIN_MS, pastBaseMs(stepMs))) };
}

/**
 * `how`, waiting as the base replay did from the mutated step on, whatever kind of replay it is, its
 * control included. Each wait runs past what the base took at that step and no further than the
 * larger of that and the hang threshold, so a dead job does not wait out a long `maxMs`. A `progress`
 * signal cannot end it early (the action that brings the signal may be what was mutated). A claim
 * with no `waitFor` gets one when the base's step outran the plain postcondition bound.
 */
export function pacedReplay(stored: Journey, how: MutationReplay, m: JourneyMutation, pace: ReplayPace): MutationReplay {
  const copy = structuredClone(how.journey);
  const original = flat(stored);
  let changed = false;
  flat(copy).forEach((recorded, i) => {
    if (i < m.step - 1) return;
    const step = recorded.step;
    const storedStep = original[i]?.step;
    const storedWait = storedStep !== undefined && "waitFor" in storedStep ? storedStep.waitFor : undefined;
    // What the claim itself took: a slow request check on the same step gives a dead claim no more room.
    const stepMs = baseClaimMs(pace, i);
    if ("waitFor" in step && step.waitFor !== undefined && storedWait !== undefined) {
      recorded.step = { ...step, waitFor: pacedWait(storedWait, stepMs) } as Step;
      changed = true;
    } else if (storedWait === undefined && stepMs > POSTCONDITION_BOUND_MS && (step.kind === "assert" || "expect" in step)) {
      recorded.step = { ...step, waitFor: { maxMs: pastBaseMs(stepMs) } } as Step;
      changed = true;
    }
  });
  const waits = how.relaxedSiteWaits?.map((w) => (w.kind === "page" && w.wait !== undefined ? { ...w, wait: pacedWait(w.wait, baseClaimMs(pace, w.step - 1)) } : w));
  return { ...how, ...(changed ? { journey: copy } : {}), ...(waits === undefined ? {} : { relaxedSiteWaits: waits }) };
}

/** When the base replay passed this failed site, from `m`'s step's start: a claim when it held, a request check when its step ended. */
function baseAtSite(f: Exclude<MutationFailedSite, { where: "unevaluable" }>, m: JourneyMutation, pace: ReplayPace): number | undefined {
  if (f.where === "end-state") return baseEndStateSinceMutation(pace, m);
  const since = baseSinceMutation(pace, m, f.step - 1);
  if (f.where !== "step" || !f.postcondition || since === undefined) return since;
  const held = pace.claimHeldMs?.[f.step - 1];
  return held === undefined ? since : held - paceBeforeMutationMs(pace, m);
}

/**
 * The failed sites this replay reached sooner than the base replay passed them. `reachedMs`: ms from
 * the mutated step's start to each step's end, 0-based. Empty when either replay measured nothing.
 */
export function sitesReachedEarly(failedSites: readonly MutationFailedSite[], m: JourneyMutation, pace: ReplayPace, reachedMs: readonly (number | undefined)[], endStateReachedMs?: number): string[] {
  const last = pace.stepEndMs.length - 1;
  return failedSites.flatMap((f) => {
    if (f.where === "unevaluable") return [];
    // A step that failed never got to its own request checks: listing one is no reading of it, so no timing to judge.
    if (f.where === "step-request" && failedSites.some((x) => x.where === "step" && x.step === f.step)) return [];
    const base = baseAtSite(f, m, pace);
    const reached = f.where === "end-state" ? (endStateReachedMs ?? reachedMs[last]) : reachedMs[f.step - 1];
    return base !== undefined && reached !== undefined && reached < base ? [failedSiteKey(f)] : [];
  });
}

/**
 * The failed sites this replay reached with little to spare over the base replay, inside twice the
 * floor's margin: a job that ran slower than the base's since then would read as sensitivity here. A
 * dead wait well past that (the hang threshold, on a quick step) has its own room.
 */
export function thinSites(failedSites: readonly MutationFailedSite[], m: JourneyMutation, pace: ReplayPace, reachedMs: readonly (number | undefined)[], endStateReachedMs?: number): string[] {
  const margin = paceMarginOf(pace, m);
  const last = pace.stepEndMs.length - 1;
  return failedSites.flatMap((f) => {
    if (f.where === "unevaluable") return [];
    const base = baseAtSite(f, m, pace);
    const reached = f.where === "end-state" ? (endStateReachedMs ?? reachedMs[last]) : reachedMs[f.step - 1];
    return base !== undefined && reached !== undefined && reached < base + 2 * margin ? [failedSiteKey(f)] : [];
  });
}

/** What the pacer held a replay for before it got to each site, 0-based by flat step, and before its end state. */
export interface ReplayHolds {
  readonly heldMs?: readonly (number | undefined)[];
  readonly endStateHeldMs?: number;
}

/**
 * The failed sites this replay got to later than the base did because it was held: a claim that only
 * lasts so long (a toast, a countdown, a short-lived token) can be what failed there, whatever the room left.
 */
export function heldSites(failedSites: readonly MutationFailedSite[], holds: ReplayHolds): string[] {
  return failedSites.flatMap((f) => {
    if (f.where === "unevaluable") return [];
    const held = f.where === "end-state" ? holds.endStateHeldMs : holds.heldMs?.[f.step - 1];
    return held !== undefined && held > 0 ? [failedSiteKey(f)] : [];
  });
}

/** When a replay got to each site: `TargetedReplayRun.arrivedMs` and `endStateReachedMs`. */
export interface SiteArrivals {
  readonly arrivedMs?: readonly (number | undefined)[];
  readonly endStateReachedMs?: number;
}

/**
 * Of `failedSites`, those a passing control did not reach within `marginMs` of when the mutated replay
 * did, either way: one that got there much later had longer than the mutated replay, and one much
 * sooner could read a claim that had gone by the time the mutated replay looked. Both replays run a
 * claim under the same bound (`pacedReplay`), so arriving together is what makes the two comparable.
 * Empty when either replay measured nothing.
 */
export function sitesUnmatchedBy(failedSites: readonly MutationFailedSite[], mutated: SiteArrivals, control: SiteArrivals, marginMs: number): string[] {
  return failedSites.flatMap((f) => {
    if (f.where === "unevaluable") return [];
    const ran = arrivalAt(f, mutated);
    const controlled = arrivalAt(f, control);
    return ran !== undefined && controlled !== undefined && Math.abs(controlled - ran) > marginMs ? [failedSiteKey(f)] : [];
  });
}

function arrivalAt(f: Exclude<MutationFailedSite, { where: "unevaluable" }>, run: SiteArrivals): number | undefined {
  return f.where === "end-state" ? (run.endStateReachedMs ?? run.arrivedMs?.at(-1)) : run.arrivedMs?.[f.step - 1];
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

/** #567: the Recording schema requires `expect` on action steps. An already-authorized
 * waived check makes no replacement claim: the action may remove its own target. */
function relaxedExpect(): Assertion {
  return { kind: "urlIncludes", text: "" };
}

/**
 * #554: the same mutation with the mutated step's OWN postcondition relaxed. `skip` skips the step
 * in place without turning its `expect` into an assert step; `block-write` and `stale-value` apply
 * the same action mutation but replace the step's `expect` with a schema-valid weak one (#567) and
 * drop `waitFor` (its `expectRequests` stay). What the claim waited for is kept as a non-fatal
 * `RelaxedSiteWait` (#785), so a later site does not fail on timing alone.
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
      const waits = relaxedSiteWaits(copy, [`step:${m.step}`]);
      const step: Record<string, unknown> = { ...target.step, expect: relaxedExpect() };
      delete step.waitFor;
      target.step = step as Step;
      return { ...how, journey: copy, relaxedSiteWaits: waits };
    }
    return { ...how, journey: copy };
  }
  if (m.kind === "block-write") {
    const requests = journeyWriteSteps(journey, opts).find((w) => w.step === m.step)?.requests ?? [];
    const blockMatchers = journeyMutationSteps(journey, opts).find((w) => w.step === m.step)?.requests ?? [];
    const copy = structuredClone(journey);
    const target = flat(copy)[index]!;
    const waits = relaxedSiteWaits(copy, [`step:${m.step}`]);
    const step: Record<string, unknown> = { ...target.step, expect: relaxedExpect() };
    delete step.waitFor;
    target.step = step as Step;
    return { journey: copy, blockIndex: index, blockRequests: [...requests], blockMatchers, relaxedSiteWaits: waits };
  }
  const copy = structuredClone(journey);
  const target = flat(copy)[index]!;
  if (target.step.kind === "fill") {
    const waits = relaxedSiteWaits(copy, [`step:${m.step}`]);
    const step: Record<string, unknown> = {
      ...target.step,
      value: { redacted: false, value: staleValue(journey, target.step, opts.params ?? {}) },
      expect: relaxedExpect(),
    };
    delete step.waitFor;
    target.step = step as Step;
    return { journey: copy, relaxedSiteWaits: waits };
  }
  return { journey: copy };
}

/**
 * #609 — how many earlier postconditions a targeted proof may weaken before it stops. A proof that
 * needs more than this is not evidence about the target; it is a cascade the run could not untangle.
 */
export const MAX_TARGETED_RELAXATIONS = 4;

/**
 * #616 — how many earlier postconditions a DECLARED targeted-proof plan may name. Higher than the
 * automatic bound because a human reviewed each relaxation; still bounded so a plan cannot relax the
 * whole Journey. Enforced at load (`metadata.targetedProofs[].relax`).
 */
export const MAX_DECLARED_RELAXATIONS = 8;

/** #609 — the site-key form of a failed site, for a refusal that names where the replay stopped. */
function failedSiteKey(f: MutationFailedSite): string {
  if (f.where === "step") return `step:${f.step}`;
  if (f.where === "step-request") return `step-request:${f.step}:${f.checkIndex}`;
  if (f.where === "end-state") return `end-state:${f.index}`;
  return "unevaluable";
}

/**
 * #609 — `relaxedMutationReplay` plus a weakened postcondition at every earlier step in
 * `relaxedSiteKeys`: a step's `expect` becomes `relaxedExpect`, an `assert` step's
 * `check` becomes the no-claim `urlIncludes ""`, and each moves its `waitFor` to a non-fatal
 * `RelaxedSiteWait` (#785). The target assertion is never relaxed, the input Journey is never modified,
 * and no step is removed (indices hold).
 * A declared `step-request:<n>:<i>` stays in the Journey and is masked by the private replay option.
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
  const requests = relaxedSiteKeys.filter((k) => k.startsWith("step-request:"));
  const relaxed = relaxStepSites(journey, base.journey, relaxedSiteKeys);
  // `base.journey` still holds these sites' own claims; the mutated step's was read when it was weakened.
  const own = base.relaxedSiteWaits ?? [];
  const waits = [...own, ...relaxedSiteWaits(base.journey, relaxedSiteKeys, base.skipIndex).filter((w) => !own.some((o) => o.site === w.site))];
  return { ...base, journey: relaxed, ...(requests.length === 0 ? {} : { relaxedStepRequests: requests }), ...(waits.length === 0 ? {} : { relaxedSiteWaits: waits }) };
}

/**
 * #609 — the CONTROL for a targeted proof: the same weakened postconditions (the relaxed sites and the
 * mutated step's own claim, as the targeted replay weakens them) with NO mutation — the supplied
 * params, nothing skipped, blocked or swapped. It must pass: when relaxing the earlier checks breaks
 * the target on its own, the target's failure is not evidence about the mutation. #785: a proof runs
 * it with `targetedControlWaits`, so the control acts and waits as the base replay did and only stops
 * judging the relaxed sites.
 */
export function targetedControlReplay(journey: Journey, m: JourneyMutation, relaxedSiteKeys: readonly string[]): MutationReplay {
  const requests = relaxedSiteKeys.filter((k) => k.startsWith("step-request:"));
  return { journey: relaxStepSites(journey, journey, controlSiteKeys(journey, m, relaxedSiteKeys)), ...(requests.length === 0 ? {} : { relaxedStepRequests: requests }) };
}

/** The sites a control weakens: the relaxed ones and the mutated step's own claim, as the targeted replay does. */
function controlSiteKeys(journey: Journey, m: JourneyMutation, relaxedSiteKeys: readonly string[]): string[] {
  const own = flat(journey)[m.step - 1]?.step;
  const ownKey = own !== undefined && (own.kind === "assert" || "expect" in own) ? [`step:${m.step}`] : [];
  return [...new Set([...ownKey, ...relaxedSiteKeys])];
}

/** #785: the waiting `targetedControlReplay`'s weakened sites did, the same as the targeted replay's. */
function targetedControlWaits(journey: Journey, m: JourneyMutation, relaxedSiteKeys: readonly string[]): RelaxedSiteWait[] {
  return relaxedSiteWaits(journey, controlSiteKeys(journey, m, relaxedSiteKeys));
}

/** The replay a proof's control runs: `targetedControlReplay` and the waiting it keeps. */
function controlWithWaits(journey: Journey, m: JourneyMutation, relaxedSiteKeys: readonly string[]): MutationReplay {
  const waits = targetedControlWaits(journey, m, relaxedSiteKeys);
  return { ...targetedControlReplay(journey, m, relaxedSiteKeys), ...(waits.length === 0 ? {} : { relaxedSiteWaits: waits }) };
}

/**
 * THE RULE. A mutated replay's failure at a site is evidence only if a control whose waiting matches
 * it, differing only by the mutation itself, passes that site.
 *
 * Every replay of a proof after the base is held to the same floors (`pacedReplay`, `paceFloorMs`), so
 * it cannot reach a site sooner than the base did. A replay that failed sooner anyway
 * (`sitesReachedEarly`) has no control. The base vouches for a failure that had room and no hold. Where
 * a site was thin, or the hold could be what broke it, or sibling mutations disagree on it, a fresh
 * unmutated replay on the same floors must pass and arrive within the margin (`sitesUnmatchedBy`). A
 * targeted proof weakens earlier sites, so it always needs its own control on the same terms. Returns
 * the refusal, or undefined for evidence.
 */
function evidenceRefusal(target: string, run: Pick<TargetedReplayRun, "outcome" | "waitsCut" | "arrivedMs" | "endStateReachedMs" | "control">, control?: Pick<TargetedReplayRun, "outcome" | "arrivedMs" | "endStateReachedMs" | "marginMs">, relaxed: readonly string[] = []): string | undefined {
  if (run.outcome === "failed" && (run.waitsCut?.length ?? 0) > 0) {
    if (run.control !== undefined && run.control !== "passed") return `the unmutated control replay did not pass (${run.control}), so the failure at ${run.waitsCut!.join(", ")} is not evidence`;
    return `the mutated replay failed at ${run.waitsCut!.join(", ")} sooner than an unmutated replay passed it, or out of step with one, so no replay matches its waiting and the failure is not evidence`;
  }
  if (control === undefined) return undefined;
  if (control.outcome !== "passed") return `the unmutated control replay with ${relaxed.join(", ")} relaxed did not pass (${control.outcome})`;
  const match = /^(?:step|step-request):([1-9][0-9]*)/.exec(target);
  const at = (r: SiteArrivals): number | undefined => (match === null ? (r.endStateReachedMs ?? r.arrivedMs?.at(-1)) : r.arrivedMs?.[Number(match[1]) - 1]);
  const ran = at(run);
  const controlled = at(control);
  if (ran !== undefined && controlled !== undefined && Math.abs(controlled - ran) > (control.marginMs ?? 0)) {
    return `the control reached ${target} at ${Math.round(controlled)}ms and the mutated replay at ${Math.round(ran)}ms, so the comparison is not evidence`;
  }
  return undefined;
}

/** Clone page defenses and validate request masks against original sites; request arrays are retained. */
function relaxStepSites(journey: Journey, from: Journey, keys: readonly string[]): Journey {
  const byKey = new Map(journeyAssertions(journey).map((s) => [assertionSiteKey(s), s]));
  const copy = structuredClone(from);
  const steps = flat(copy);
  for (const key of keys) {
    if (/^step-request:[1-9][0-9]*:[0-9]+$/.test(key)) {
      if (byKey.get(key)?.where !== "step-request") throw new Error(`${key} is not an assertion site of this Journey`);
      continue; // private replay mask; never remove checks or renumber assertion identities
    }
    const match = /^step:([1-9][0-9]*)$/.exec(key);
    if (match === null) throw new Error(`${key} is not a step assertion site — a targeted proof only relaxes step:<n>`);
    const site = byKey.get(key);
    if (site !== undefined && site.where === "step" && site.field === "resume") throw new Error(`${key} is a resume assertion — a targeted proof never relaxes it`);
    const recorded = steps[Number(match[1]) - 1];
    if (recorded === undefined) throw new Error(`journey '${journey.metadata.id}' has no step ${match[1]} to relax`);
    const step: Record<string, unknown> = { ...recorded.step };
    if (recorded.step.kind === "assert") step.check = { kind: "urlIncludes", text: "" };
    else if ("expect" in recorded.step) step.expect = relaxedExpect();
    else throw new Error(`${key} has no page postcondition to relax`);
    delete step.waitFor;
    recorded.step = step as Step;
  }
  return copy;
}

/**
 * #817: a check that asserts an absence (`count` with `max: 0`, an `attr` with `absent: true`), page or
 * after reload. It holds on a page or view that has not loaded as well as on one the write emptied.
 */
function isAbsenceCheck(check: JourneyAssertionSite["check"]): boolean {
  const a = check.kind === "page" || check.kind === "reloadThen" ? check.assertion : check;
  if (a.kind === "count") return a.max === 0 && (a.min ?? 0) === 0;
  if (a.kind === "attr") return a.absent === true;
  return false;
}

/**
 * #817 — static, before any browser: an end-state absence check that shares its paired mutations with
 * sibling end-state checks. End-state checks are judged independently and a targeted proof never relaxes
 * one, so if it holds while its siblings fail (as an absence does on a view that has not loaded) its
 * cascade is final. A note only: it never changes a pairing or a verdict.
 */
export function endStateIsolationNotes(journey: Journey, plan: MutationPlan): readonly { readonly site: string; readonly note: string }[] {
  const notes: { site: string; note: string }[] = [];
  for (const site of journeyAssertions(journey)) {
    if (site.where !== "end-state" || !isAbsenceCheck(site.check)) continue;
    const key = assertionSiteKey(site);
    const mine = [...new Set(plan.pairs.filter((p) => p.site === key).map((p) => p.mutation))].sort();
    const shared = mine.filter((id) => plan.pairs.some((p) => p.mutation === id && p.site !== key && p.site.startsWith("end-state:")));
    if (shared.length === 0) continue;
    const siblings = [...new Set(plan.pairs.filter((p) => shared.includes(p.mutation) && p.site !== key && p.site.startsWith("end-state:")).map((p) => p.site))].sort((a, b) => Number(a.slice(10)) - Number(b.slice(10)));
    notes.push({
      site: key,
      note: `${key} checks an absence (it also holds on a page or view that has not loaded) and shares ${shared.join(", ")} with sibling end-state checks ${siblings.join(", ")}: if it holds while they fail, no targeted proof can isolate it (sibling end-state checks are never relaxed) and it stays a cascade; first wait for content that shows the view loaded`,
    });
  }
  return notes;
}

/**
 * #609 — the next earlier postcondition a targeted proof should weaken to reach `targetSiteKey`, or
 * `{refuse}` when there is no defensible one, or null when the target is no longer a cascade. A
 * relaxable failure is the FIRST failed site, either a page postcondition or request assertion, at
 * or after the mutated step, before the target, paired with `m` (its own sensitivity evidence), not
 * already relaxed, and within `MAX_TARGETED_RELAXATIONS`.
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
  // What a target that held under this mutation can do about it: it is not this mutation's to prove as it stands.
  const heldAdvice = (): string => (target.where === "end-state" ? `pair ${targetSiteKey} with the mutation of the step whose write it reads` : `make ${targetSiteKey}'s own check read what ${m.id} removes`);
  if (first.where === "end-state") {
    const siblings = result.failedSites.flatMap((f) => (f.where === "end-state" ? [failedSiteKey(f)] : []));
    // #817: end-state checks are all judged, independently: the target was read and held, so no sibling blocked it.
    if (target.where === "end-state") {
      const absence = isAbsenceCheck(target.check);
      return {
        refuse:
          `${targetSiteKey} was judged and held under ${m.id} while its sibling end-state checks ${siblings.join(", ")} failed: end-state checks are judged independently, so no sibling is relaxed to isolate it (unsupported, and it would change nothing); ` +
          `the base passed ${targetSiteKey} as well, so it holds with and without what ${m.id} removes${absence ? ", and as an absence check it also holds on a page or view that has not loaded" : ""}; ` +
          `make ${targetSiteKey} read state ${m.id} removes${absence ? " (for an absence check, first wait for content that shows the view loaded)" : ""}, or remove ${targetSiteKey}'s claim`,
      };
    }
    return { refuse: `${failedSiteKey(first)} is not an earlier step assertion: ${siblings.length === 1 ? `only ${siblings[0]} failed` : `${siblings.join(", ")} failed`}, so ${targetSiteKey} held under ${m.id} and cannot show what it changes; ${heldAdvice()}, or remove ${targetSiteKey}'s claim` };
  }
  const key = failedSiteKey(first);
  if (first.where === "step" && !first.postcondition) return { refuse: `${key} action failed (not a postcondition)` };
  if (first.step < m.step) return { refuse: "failure before the mutated step" };
  const step = flat(journey)[first.step - 1]?.step;
  if (step === undefined) return { refuse: `${key} does not exist` };
  if (first.where === "step" && step.kind === "handback") return { refuse: `${key} is a resume assertion (not a relaxable page postcondition)` };
  if ((target.where === "step" || target.where === "step-request") && target.step === first.step) {
    return { refuse: `${key} is not before the target ${targetSiteKey}: both are step ${first.step}, and its postcondition fails before the request check is judged; move the request check to a later step or the end state` };
  }
  if ((target.where === "step" || target.where === "step-request") && target.step < first.step) {
    return { refuse: `${key} is not before the target ${targetSiteKey}: the replay got past ${targetSiteKey} and failed at ${key}, so ${targetSiteKey} held under ${m.id} and cannot show what it changes; ${heldAdvice()} (for example, move ${key}'s check onto it), or remove ${targetSiteKey}'s claim` };
  }
  if (!plan.pairs.some((p) => p.site === key && p.mutation === m.id)) {
    return { refuse: `${key} is not paired with ${m.id}: if it depends on ${m.id}, add {"check":"${key}","mustFailWhen":"${m.id}"} to metadata.mutationPairs, and the proof can relax it to reach ${targetSiteKey}` };
  }
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
  replay: (describe: (journey: Journey) => MutationReplay, kind: "targeted" | "control", controlKey?: string) => Promise<TargetedReplayRun>,
  opts: MutationReplayOptions = {},
): Promise<TargetedProof> {
  const site = assertionSiteKey(target);
  const relaxedSites: string[] = [];
  const relaxedFirst =
    initial.relaxed !== undefined &&
    initial.failedSites.some((f) => f.where === "step" && f.step === m.step && f.postcondition) &&
    !(target.where === "step" && target.step === m.step);
  let run: TargetedReplayRun = relaxedFirst
    ? { outcome: initial.relaxed!.outcome, failedSites: initial.relaxed!.failedSites, ...(initial.relaxed!.waitsCut === undefined ? {} : { waitsCut: initial.relaxed!.waitsCut }), ...(initial.control === undefined ? {} : { control: initial.control }) }
    : { outcome: initial.outcome, failedSites: initial.failedSites, ...(initial.waitsCut === undefined ? {} : { waitsCut: initial.waitsCut }), ...(initial.control === undefined ? {} : { control: initial.control }) };
  for (;;) {
    const cut = evidenceRefusal(site, run);
    if (cut !== undefined) {
      return { site, relaxedSites, outcome: run.outcome, failedSites: run.failedSites, ...(initial.control === undefined ? {} : { control: initial.control }), refused: cut, ...(initial.controlDiagnostics === undefined ? {} : { controlDiagnostics: initial.controlDiagnostics }) };
    }
    const next = nextTargetedRelaxation(journey, plan, m, site, run, relaxedSites);
    if (next === null) break;
    if ("refuse" in next) return { site, relaxedSites, outcome: run.outcome, failedSites: run.failedSites, refused: next.refuse };
    relaxedSites.push(next.relax);
    // The replay is described per Journey it is given (the stored one moved onto the environment).
    const relaxedNow = [...relaxedSites];
    run = await replay((j) => targetedMutationReplay(j, m, site, relaxedNow, opts), "targeted", relaxedNow.join(","));
  }
  if (relaxedSites.length > 0 && classifyMutationPlain(target, m, run) === "sensitive") {
    // A failure counts only when the same relaxations WITHOUT the mutation still pass.
    const control = await replay((j) => controlWithWaits(j, m, relaxedSites), "control", relaxedSites.join(","));
    const refused = evidenceRefusal(site, run, control, relaxedSites);
    return { site, relaxedSites, outcome: run.outcome, failedSites: run.failedSites, control: control.outcome, ...(refused === undefined ? {} : { refused }), ...(control.outcome === "passed" || control.diagnostics === undefined ? {} : { controlDiagnostics: control.diagnostics }) };
  }
  return { site, relaxedSites, outcome: run.outcome, failedSites: run.failedSites };
}

/**
 * #616 — a DECLARED targeted proof: the plan names exactly which earlier postconditions a human
 * reviewed and allows the proof to relax, so a layered Journey whose automatic #609 proof hits
 * `MAX_TARGETED_RELAXATIONS` can still prove a late assertion. It refuses (no replay at all) unless
 * every `relax` site is paired with `m.id`. Otherwise it runs EXACTLY ONE targeted replay with that
 * relax list; when the replay stops first at an undeclared earlier postcondition (not in `relax`)
 * before the target, it refuses naming that site. When `classifyMutationPlain` makes the target
 * sensitive, it runs EXACTLY ONE unmutated control replay, which must pass (as `runTargetedProof`).
 * The target assertion is never relaxed. Total replays per plan: at most two.
 */
export async function runDeclaredTargetedProof(
  journey: Journey,
  plan: MutationPlan,
  m: JourneyMutation,
  target: JourneyAssertionSite,
  declared: JourneyTargetedProofPlan,
  replay: (describe: (journey: Journey) => MutationReplay, kind: "targeted" | "control", controlKey?: string) => Promise<TargetedReplayRun>,
  opts: MutationReplayOptions = {},
): Promise<TargetedProof> {
  const site = assertionSiteKey(target);
  const relax = declared.relax;
  const unpaired = relax.find((key) => !plan.pairs.some((p) => p.site === key && p.mutation === m.id));
  if (unpaired !== undefined) {
    return { site, relaxedSites: relax, outcome: "error", failedSites: [], declared: true, refused: `${unpaired} is not paired with ${m.id}` };
  }
  const relaxedNow = [...relax];
  const run = await replay((j) => targetedMutationReplay(j, m, site, relaxedNow, opts), "targeted", relaxedNow.join(","));
  const first = run.failedSites[0];
  if (first !== undefined && ((first.where === "step" && first.postcondition) || first.where === "step-request") && !relax.includes(failedSiteKey(first)) && (target.where === "end-state" || first.step < target.step)) {
    const key = failedSiteKey(first);
    return { site, relaxedSites: relax, outcome: run.outcome, failedSites: run.failedSites, declared: true, refused: `${key} blocked the declared proof (not in relax)` };
  }
  const cut = evidenceRefusal(site, run);
  if (cut !== undefined) return { site, relaxedSites: relax, outcome: run.outcome, failedSites: run.failedSites, declared: true, refused: cut };
  if (classifyMutationPlain(target, m, run) === "sensitive") {
    const control = await replay((j) => controlWithWaits(j, m, relaxedNow), "control", relaxedNow.join(","));
    const refused = evidenceRefusal(site, run, control, relax);
    return { site, relaxedSites: relax, outcome: run.outcome, failedSites: run.failedSites, declared: true, control: control.outcome, ...(refused === undefined ? {} : { refused }), ...(control.outcome === "passed" || control.diagnostics === undefined ? {} : { controlDiagnostics: control.diagnostics }) };
  }
  return { site, relaxedSites: relax, outcome: run.outcome, failedSites: run.failedSites, declared: true };
}

/**
 * #616 — a reviewable start for `metadata.targetedProofs`: when an automatic #609 proof stopped at
 * the relaxation bound, name the sites it already relaxed plus the blocking site that needs one more
 * relaxation. Returns null for any other refusal (not a bound the declaration can fix), for no
 * blocking step, or when the result would exceed `MAX_DECLARED_RELAXATIONS`.
 */
export function suggestTargetedProofPlan(proof: TargetedProof, m: JourneyMutation): JourneyTargetedProofPlan | null {
  if (proof.refused !== `relaxation bound ${MAX_TARGETED_RELAXATIONS} reached`) return null;
  const first = proof.failedSites[0];
  if (first === undefined || (first.where !== "step" && first.where !== "step-request")) return null;
  const relax = [...proof.relaxedSites, failedSiteKey(first)];
  if (relax.length > MAX_DECLARED_RELAXATIONS) return null;
  return { check: proof.site, mustFailWhen: m.id, relax };
}

/**
 * #616 — the declared `metadata.targetedProofs` plan for assertion site `siteKey` that a human
 * reviewed against mutation `m` (its `mustFailWhen` resolves to `m.id`), or undefined. An
 * unresolvable ref is skipped here: the load-time schema refuses it.
 */
export function declaredTargetedProofFor(journey: Journey, m: JourneyMutation, siteKey: string): JourneyTargetedProofPlan | undefined {
  for (const plan of journey.metadata.targetedProofs ?? []) {
    if (plan.check !== siteKey) continue;
    try {
      if (resolveMutationRef(journey, plan.mustFailWhen).id === m.id) return plan;
    } catch {
      // An unresolvable `mustFailWhen` is a schema error, not this lookup's concern.
    }
  }
  return undefined;
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

/** A site one mutation failed and a sibling mutation of the same step passed. */
export interface SiblingDisagreement {
  readonly site: string;
  readonly sensitive: string;
  readonly passed: string;
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
