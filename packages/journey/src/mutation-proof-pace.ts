import type { OutcomeWait, RecordedStep, Step } from "@jevitate/recording";
import { WAIT_FOR_STALL_MS } from "@jevitate/recording";
import type { Journey } from "./journey.js";
import type {
  JourneyMutation,
  MutationFailedSite,
  MutationReplay,
  RelaxedSiteWait,
  ReplayHolds,
  ReplayPace,
  SiteArrivals,
} from "./mutation-proof-types.js";

export function flat(journey: Journey): RecordedStep[] {
  return journey.recording.pages.flatMap((p) => p.steps);
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

/** The page wait of `step`'s own claim, read BEFORE it is weakened; null for a step with no claim. */
export function pageSiteWait(step: Step, n: number): RelaxedSiteWait | null {
  const assertion = step.kind === "assert" ? step.check : "expect" in step ? step.expect : null;
  if (assertion === null) return null;
  const wait = "waitFor" in step ? step.waitFor : undefined;
  return wait === undefined ? { kind: "page", site: `step:${n}`, step: n, assertion } : { kind: "page", site: `step:${n}`, step: n, assertion, wait };
}

/** #785: the waits of `keys`, read from `from` before its sites are weakened. A step the replay leaves out waits for nothing. */
export function relaxedSiteWaits(from: Journey, keys: readonly string[], skipIndex?: number): RelaxedSiteWait[] {
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

/** #609 — the site-key form of a failed site, for a refusal that names where the replay stopped. */
export function failedSiteKey(f: MutationFailedSite): string {
  if (f.where === "step") return `step:${f.step}`;
  if (f.where === "step-request") return `step-request:${f.step}:${f.checkIndex}`;
  if (f.where === "end-state") return `end-state:${f.index}`;
  return "unevaluable";
}
