import type { Assertion, NetworkCheck, OutcomeCheck, Step, TargetDescriptor } from "@jevitate/recording";
import type { Journey } from "./journey.js";

/**
 * #400 — every assertion a Journey makes, with where it sits. The shared view the assertion-strength
 * lint (#401) and the mutation proof (#402) read, so neither re-walks the Journey on its own:
 *
 *  - `step` — a top-level step's page postcondition (`expect`), an `assert` step's `check`, or a
 *    `handback`'s `resume`; `step` is 1-based, counted the way `--at-step <n>` and anchors count;
 *  - `step-request` — a step's `expectRequests` network check (judged over the requests the replay
 *    sent from that step on): the step it is paired with is `step`, its position in that step's
 *    `expectRequests` is `checkIndex` (#402);
 *  - `end-state` — `metadata.endState` in order, then an older Journey's `metadata.networkChecks`
 *    (`source` says which), judged after the last step.
 *
 * `forEach` children are not listed (their checks are row-scoped).
 */
export type JourneyAssertionSite =
  | {
      readonly where: "step";
      readonly step: number;
      readonly field: "expect" | "check" | "resume";
      readonly check: Extract<OutcomeCheck, { kind: "page" }>;
    }
  | { readonly where: "step-request"; readonly step: number; readonly checkIndex: number; readonly check: NetworkCheck }
  | { readonly where: "end-state"; readonly index: number; readonly source: "endState" | "networkChecks"; readonly check: OutcomeCheck };

export function journeyAssertions(journey: Journey): JourneyAssertionSite[] {
  const out: JourneyAssertionSite[] = [];
  let n = 0;
  for (const page of journey.recording.pages) {
    for (const recorded of page.steps) {
      n += 1;
      const s = recorded.step;
      const own = ownAssertion(s);
      if (own !== null) out.push({ where: "step", step: n, field: own.field, check: { kind: "page", assertion: own.assertion } });
      (recorded.expectRequests ?? []).forEach((check, checkIndex) => out.push({ where: "step-request", step: n, checkIndex, check }));
    }
  }
  const end = journey.metadata.endState ?? [];
  end.forEach((check, index) => out.push({ where: "end-state", index, source: "endState", check }));
  (journey.metadata.networkChecks ?? []).forEach((check, i) =>
    out.push({ where: "end-state", index: end.length + i, source: "networkChecks", check }),
  );
  return out;
}

/** #400: the checks `journey run` judges after the last step — `endState`, then the legacy `networkChecks`. */
export function journeyEndState(journey: Journey): OutcomeCheck[] {
  return [...(journey.metadata.endState ?? []), ...(journey.metadata.networkChecks ?? [])];
}

function ownAssertion(s: Step): { field: "expect" | "check" | "resume"; assertion: Assertion } | null {
  if (s.kind === "assert") return { field: "check", assertion: s.check };
  if (s.kind === "handback") return { field: "resume", assertion: s.resume };
  return "expect" in s ? { field: "expect", assertion: s.expect } : null;
}

/** A descriptor with its keys sorted (recursively), for a structural comparison. */
function canonical(d: TargetDescriptor): string {
  const sort = (v: unknown): unknown =>
    v !== null && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, sort(x)]))
      : v;
  return JSON.stringify(sort(d));
}

/**
 * #400: is the step's `expect` "the step's own target is visible"? That holds before AND after the
 * action, so it proves nothing about what the step did (the per-step form of #202's vacuous check).
 * Authoring never emits it for a click or type step; the lint (#401) flags it.
 */
export function isOwnTargetVisible(step: Step): boolean {
  if (!("expect" in step) || !("target" in step)) return false;
  return step.expect.kind === "visible" && canonical(step.expect.target) === canonical(step.target);
}

/**
 * #400: is the step's `expect` an explicit "no claim" — `count … min 0` (always true: attached or
 * gone) or `urlIncludes ""`? Authoring writes it for a step it found no evidence of an effect for,
 * rather than a vacuous claim that looks like one; the lint (#401) reads it as "no assertion here".
 */
export function isNoClaimExpect(step: Step): boolean {
  if (!("expect" in step)) return false;
  const e = step.expect;
  return (e.kind === "count" && (e.min ?? 0) === 0 && e.max === undefined) || (e.kind === "urlIncludes" && e.text === "");
}
