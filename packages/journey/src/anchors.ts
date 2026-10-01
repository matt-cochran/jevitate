import type { PageSegment } from "@jevitate/recording";
import { describeStep, flatJourneySteps } from "./intent.js";
import type { Journey, JourneyAnchor } from "./journey.js";

/**
 * #293 — journey-anchored exploration: where a Journey's prefix ends. A mission can start from a
 * named anchor or a step number of a promoted Journey instead of a bare URL; these helpers resolve
 * that branch point and cut the Journey down to the prefix that reaches it. Pure: no I/O, no browser.
 */

/** `--at-step` named nothing the Journey has (an unknown anchor, a step out of range, a malformed value). */
export class JourneyStepError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JourneyStepError";
  }
}

/** Where a mission branches off a Journey: after `step` top-level steps (1-based), by anchor name when it has one. */
export interface JourneyBranchPoint {
  readonly journeyId: string;
  /** Top-level steps replayed before the mission starts (1-based: the state AFTER step `step`). */
  readonly step: number;
  /** The anchor's name, when the branch point was named by one (or a step that has one). */
  readonly anchor?: string;
  /** The last replayed step, described without values (a fill shows `<param x>`, never a secret). */
  readonly stepLabel?: string;
}

/** One anchor as `journey anchors <id>` lists it. */
export interface JourneyAnchorListing {
  readonly name: string;
  readonly step: number;
  /** The step the anchor follows, described without values. */
  readonly afterStep: string;
  readonly description?: string;
  readonly probes: readonly string[];
}

/** The Journey's top-level step count (the interpreter's flat numbering). */
export function journeyStepCount(journey: Journey): number {
  return flatJourneySteps(journey).length;
}

function stepLabel(journey: Journey, step: number): string | undefined {
  const s = flatJourneySteps(journey)[step - 1];
  if (s === undefined) return undefined;
  const pick = [s.recorded.objective, s.recorded.step.label].map((t) => (t ?? "").trim()).find((t) => t !== "");
  return pick ?? describeStep(s.recorded.step);
}

/** The Journey's declared anchors, in declaration order, each with the step it follows. */
export function listJourneyAnchors(journey: Journey): JourneyAnchorListing[] {
  return (journey.metadata.anchors ?? []).map((a) => ({
    name: a.name,
    step: a.step,
    afterStep: stepLabel(journey, a.step) ?? `step ${a.step}`,
    ...(a.description === undefined ? {} : { description: a.description }),
    probes: [...(a.probes ?? [])],
  }));
}

/**
 * Resolves `--at-step <n|name>`: a positive step number (1..the Journey's step count) or a declared
 * anchor's name. A number that one anchor names comes back with that anchor. Throws
 * `JourneyStepError` (naming the valid choices) for anything else — never a guess.
 */
export function resolveJourneyStep(journey: Journey, atStep: string): { readonly step: number; readonly anchor?: JourneyAnchor } {
  const count = journeyStepCount(journey);
  const anchors = journey.metadata.anchors ?? [];
  const value = atStep.trim();
  const choices = (): string =>
    `steps 1..${count}${anchors.length === 0 ? " (the Journey declares no anchors)" : ` or an anchor: ${anchors.map((a) => a.name).join(", ")}`}`;
  if (/^[0-9]+$/.test(value)) {
    const step = Number(value);
    if (!Number.isSafeInteger(step) || step < 1 || step > count) {
      throw new JourneyStepError(`--at-step ${value} is not a step of journey '${journey.metadata.id}' (${choices()})`);
    }
    const named = anchors.filter((a) => a.step === step);
    return named.length === 1 ? { step, anchor: named[0]! } : { step };
  }
  const anchor = anchors.find((a) => a.name === value);
  if (anchor === undefined) {
    throw new JourneyStepError(`--at-step ${JSON.stringify(value)} names no anchor of journey '${journey.metadata.id}' (${choices()})`);
  }
  if (anchor.step > count) throw new JourneyStepError(`anchor ${JSON.stringify(anchor.name)} is past the Journey's last step (${count})`);
  return { step: anchor.step, anchor };
}

/** The branch point a resolved `--at-step` names (what results and findings record). */
export function journeyBranchPoint(journey: Journey, resolved: { readonly step: number; readonly anchor?: JourneyAnchor }): JourneyBranchPoint {
  const label = stepLabel(journey, resolved.step);
  return {
    journeyId: journey.metadata.id,
    step: resolved.step,
    ...(resolved.anchor === undefined ? {} : { anchor: resolved.anchor.name }),
    ...(label === undefined ? {} : { stepLabel: label }),
  };
}

/**
 * The Journey cut to its first `steps` top-level steps: the prefix a replay runs before the mission
 * takes over. Page segments past the cut are dropped (an emptied segment too); everything else —
 * metadata, site, emulation, extensions — is kept, so the prefix replays under the same policy.
 */
export function journeyPrefix(journey: Journey, steps: number): Journey {
  if (!Number.isSafeInteger(steps) || steps < 1 || steps > journeyStepCount(journey)) {
    throw new JourneyStepError(`journey '${journey.metadata.id}' has no step ${steps}`);
  }
  let left = steps;
  const pages: PageSegment[] = [];
  for (const p of journey.recording.pages) {
    if (left === 0) break;
    const taken = p.steps.slice(0, left);
    left -= taken.length;
    if (taken.length > 0) pages.push({ ...p, steps: taken });
  }
  return { ...journey, recording: { ...journey.recording, pages } };
}

/**
 * Where the prefix most likely leaves the page, as a path (or URL) from the Recording alone — used
 * only before any browser opens (to decide the run's origin and settings). When the last replayed
 * step closes its page segment and another follows, the step navigated there; otherwise the page
 * is still the segment's own. The mission itself starts from the LIVE page, wherever it is.
 */
export function prefixLandingPath(journey: Journey, steps: number): string {
  let seen = 0;
  const pages = journey.recording.pages;
  for (let i = 0; i < pages.length; i++) {
    const p = pages[i]!;
    seen += p.steps.length;
    if (seen >= steps) {
      const next = pages.slice(i + 1).find((q) => q.url.trim() !== "");
      return seen === steps && p.steps.length > 0 && next !== undefined ? next.url : p.url;
    }
  }
  return pages.at(-1)?.url ?? "/";
}
