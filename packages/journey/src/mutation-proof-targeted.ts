import type { Assertion, Step } from "@jevitate/recording";
import { classifyMutation, classifyMutationPlain } from "@jevitate/adjudicator";
import type { Journey, JourneyTargetedProofPlan } from "./journey.js";
import { journeyAssertions, type JourneyAssertionSite } from "./assertions.js";
import { journeyMutationSteps, journeyWriteSteps, type JourneyLintOptions } from "./lint.js";
import { resolveJourneyStep } from "./anchors.js";
import { secretParamNames } from "./intent.js";
import { actionRefs, alteredValue, mutableParamValue, pinAssertionRefs, siteRefs, swappedValue, truncatedValue } from "./mutation-proof-refs.js";
import { failedSiteKey, flat, relaxedSiteWaits } from "./mutation-proof-pace.js";
import type {
  JourneyMutation,
  MutationFailedSite,
  MutationKind,
  MutationPlan,
  MutationReplay,
  MutationRunResult,
  RelaxedSiteWait,
  SiteArrivals,
  TargetedProof,
  TargetedReplayRun,
} from "./mutation-proof-types.js";

/** `step:<n>` · `step-request:<n>:<i>` · `end-state:<i>` — the names `metadata.mutationPairs` uses. */
export function assertionSiteKey(site: JourneyAssertionSite): string {
  if (site.where === "step") return `step:${site.step}`;
  if (site.where === "step-request") return `step-request:${site.step}:${site.checkIndex}`;
  return `end-state:${site.index}`;
}

const MUTATION_RE = /^(skip|block-write|stale-value|swap-param|truncate-param|guard-param):(.+)$/;

export const SITE_RE = /^(?:step:[1-9][0-9]*|step-request:[1-9][0-9]*:(?:0|[1-9][0-9]*)|end-state:(?:0|[1-9][0-9]*))$/;

export function mutation(kind: MutationKind, step: number): JourneyMutation {
  return { kind, step, id: `${kind}:${step}` };
}

/** The first (1-based) step whose action reads `name`, or null when no action does. */
export function firstActionStep(journey: Journey, name: string): number | null {
  const i = flat(journey).findIndex((r) => actionRefs(r.step).includes(name));
  return i < 0 ? null : i + 1;
}

/**
 * #579: the first reviewed `mutationValues` entry of parameter `name` that differs from the supplied
 * value — a value a human checked is valid for the page but wrong for this run — or null.
 */
export function reviewedValue(journey: Journey, name: string, supplied: string): string | null {
  const declared = (journey.metadata.parameters ?? []).find((p) => p.name === name);
  return declared?.mutationValues?.find((v) => v !== supplied) ?? null;
}

/** #579: is `step` a `select` whose value is exactly the `{ var }` reference `name`? */
function selectsVar(step: Step, name: string): boolean {
  return step.kind === "select" && "var" in step.value && step.value.var === name;
}

export function paramMutation(kind: "swap-param" | "truncate-param" | "guard-param", step: number, param: string): JourneyMutation {
  return { kind, step, id: `${kind}:${param}`, param };
}

/**
 * #580: the step sites that GUARD parameter `name`: assertions naming it that run before any action
 * reads it (or naming one no action reads, like an `expected_*` context check). They compare the
 * page with the run's input, so only a wrong INPUT can break them — a `guard-param` mutation.
 */
export function guardSites(journey: Journey, sites: readonly JourneyAssertionSite[], name: string): StepAssertionSite[] {
  const action = firstActionStep(journey, name);
  return sites.filter((s): s is StepAssertionSite => s.where === "step" && siteRefs(s).includes(name) && (action === null || s.step < action));
}

type StepAssertionSite = Extract<JourneyAssertionSite, { readonly where: "step" }>;

/** A declared `swap-param:<name>` / `truncate-param:<name>`: a non-secret parameter an action reads. */
export function paramMutationRef(journey: Journey, kind: "swap-param" | "truncate-param" | "guard-param", name: string, value: string): JourneyMutation {
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
export function resolveMutationRef(journey: Journey, value: string): JourneyMutation {
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
 * #565: the variable a `{ var }` fill types, when it is not secret and some assertion names it — the
 * stale-value mutation of such a fill types an altered value (when the value is known) instead of "".
 */
export function varFillRef(journey: Journey, step: Step, params: Readonly<Record<string, string>>): string | null {
  if (step.kind !== "fill" || !("var" in step.value)) return null;
  const name = step.value.var;
  if (secretParamNames(journey, params).includes(name)) return null;
  return journeyAssertions(journey).some((s) => siteRefs(s).includes(name)) ? name : null;
}

/** What a stale-value mutation types into fill `step`: an altered non-secret param value, else "". */
export function staleValue(journey: Journey, step: Step, params: Readonly<Record<string, string>>): string {
  const name = varFillRef(journey, step, params);
  if (name === null) return "";
  const v = mutableParamValue(journey, name, params);
  return v === null ? "" : alteredValue(v);
}

/** #565: what `mutationReplay` takes — the lint options, and the params the proof runs with. */
export type MutationReplayOptions = JourneyLintOptions & { readonly params?: Readonly<Record<string, string>> };

/**
 * #565: a param mutation's replay — the params with `m.param` swapped or truncated, and a copy of the
 * Journey whose assertions naming it are pinned to the SUPPLIED value. Throws when the parameter has
 * no mutable value (not supplied, blank, or secret).
 */
export function paramReplay(journey: Journey, m: JourneyMutation, params: Readonly<Record<string, string>>): MutationReplay {
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
