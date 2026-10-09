import type { SelfHealer } from "@jevitate/runtime";
import { runGoalBasedMission } from "@jevitate/explore";
import type { JudgmentPort, GenerationPort } from "@jevitate/ai-core";
import type { Actor } from "@jevitate/screenplay";
import { BrowseTheWebToken } from "@jevitate/screenplay";
import type { Assertion, Step } from "@jevitate/recording";

/**
 * The real `@jevitate/runtime.SelfHealer`, backed by `@jevitate/explore`'s
 * `runGoalBasedMission`. This is the ONLY edge from the CLI to
 * `@jevitate/explore` used for self-healing — `@jevitate/runtime` itself
 * never depends on `@jevitate/explore` (it only knows the `SelfHealer`
 * port), preserving ticket #1's "nothing depends on explore except cli"
 * constraint.
 *
 * DEVIATION (real-API vs plan): the plan assumed `runGoalBasedMission` took a
 * loose `{goal, successAssertion, allowlist, actor, judgment, generation}`
 * bag returning `{outcome, recording, transcript}`. The SHIPPED API
 * (`GoalBasedMissionConfig` = `Omit<ExploreConfig,"missionContext"> +
 * successAssertion`) takes a single config object with `judge`/`gen` (not
 * `judgment`/`generation`) and REQUIRES `startUrl` + `allowlist`, returning a
 * `GoalBasedResult` whose `outcome` is `"succeeded" | "exhausted" |
 * "blocked"`. Only `"succeeded"` (the independent oracle held) yields a
 * candidate; everything else yields none — and even a candidate is only a
 * proposal the JourneyRunner adjudicates (#453: proof untouched, change
 * evidence, the floor, the probe). The healer never certifies its own success.
 *
 * DEVIATION (start-from-live-state): the plan's `SelfHealer` contract says
 * the actor is already sitting in the live state right after the last-good
 * step, so no re-navigation is needed. The shipped `explore()` ALWAYS
 * navigates to `startUrl` first, so this adapter re-anchors by using the
 * actor's CURRENT live URL as `startUrl` (a reload of the page we are
 * already on) — the closest the shipped mission API allows. Flagged as a
 * follow-up: a future `runGoalBasedMission` variant could skip the initial
 * navigation to honor the pure resume-from-state design.
 */
export function makeExploreSelfHealer(judgment: JudgmentPort, generation: GenerationPort): SelfHealer {
  return {
    // The goal mission clicks and types to reach the postcondition: it is never consulted for a
    // guarded click/fill step (#453), whose probe must run under the write blocker.
    actsOnPage: true,
    async proposeCandidates({ actor, brokenStep, allowedOrigins, secrets }) {
      const expectedPostcondition = postconditionOf(brokenStep);
      if (expectedPostcondition === undefined) return { candidates: [], usage: { modelCalls: 0 }, reason: `a ${brokenStep.kind} step has no postcondition to re-learn` };
      const allowlist = allowedOrigins ?? [];
      const result = await runGoalBasedMission({
        goal: describeBrokenStepGoal(brokenStep),
        successAssertion: expectedPostcondition,
        allowlist,
        // Re-anchor to the live page we are already on (see DEVIATION above).
        // Authorization is still enforced by explore's own
        // `assertAuthorizedExploreTarget` against `allowlist` — an
        // off-allowlist current URL fails closed there (it throws), never
        // silently healed.
        startUrl: currentUrl(actor, allowlist),
        actor,
        judge: judgment,
        gen: generation,
        // #399: the run's secret params (the live URL may carry one) are redacted from every prompt.
        ...(secrets === undefined || secrets.length === 0 ? {} : { secrets }),
      });
      const usage = { modelCalls: result.transcript.length };
      if (result.outcome !== "succeeded") return { candidates: [], usage, reason: `re-learn mission ${result.outcome}` };
      // #453: only a ONE-step re-learn of the same kind is a candidate, and only its locator is
      // proposed — the broken step's proof stays as recorded (the runner re-checks it).
      const learned = result.recording.pages.flatMap((p) => p.steps.map((s) => s.step));
      const retarget = learned.length === 1 ? retargetOf(brokenStep, learned[0]!) : undefined;
      return retarget === undefined
        ? { candidates: [], usage, reason: `re-learn mission took ${learned.length} step(s), not one ${brokenStep.kind} step` }
        : { candidates: [{ step: retarget, hypothesis: `re-learned the ${brokenStep.kind} step's locator from the live page` }], usage };
    },
  };
}

/** The broken step's own postcondition (what the re-learn must reach), if it has one. */
function postconditionOf(step: Step): Assertion | undefined {
  return "expect" in step ? step.expect : undefined;
}

/** `broken` with `learned`'s locator, when both are the same kind of located step. */
function retargetOf(broken: Step, learned: Step): Step | undefined {
  if (broken.kind !== learned.kind) return undefined;
  if (broken.kind === "navigate" && learned.kind === "navigate") return { ...broken, url: learned.url };
  if ("target" in broken && "target" in learned) return { ...broken, target: learned.target } as Step;
  return undefined;
}

/** The actor's current live URL — the natural start for a scoped re-learn.
 * Falls back to the first authorized origin when the actor exposes no live
 * browsing ability (e.g. a test double); an empty allowlist then yields ""
 * and explore's authorization guard fails closed. */
function currentUrl(actor: Actor, fallbackOrigins: readonly string[]): string {
  try {
    return actor.ability(BrowseTheWebToken).session.page.url();
  } catch {
    return fallbackOrigins[0] ?? "";
  }
}

function describeBrokenStepGoal(step: Step): string {
  return `Perform the equivalent of a "${step.kind}" step to satisfy the expected postcondition — the site appears to have changed since this step was recorded.`;
}
