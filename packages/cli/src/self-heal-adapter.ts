import type { SelfHealer } from "@jevitate/runtime";
import { runGoalBasedMission } from "@jevitate/explore";
import type { JudgmentPort, GenerationPort } from "@jevitate/ai-core";
import type { Actor } from "@jevitate/screenplay";
import { BrowseTheWebToken } from "@jevitate/screenplay";
import type { Step } from "@jevitate/recording";

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
 * "blocked"`. Only `"succeeded"` (the independent oracle held) maps to
 * `"healed"`; everything else is `"not-healed"` — the healer never certifies
 * its own success (guardrail #4, mirrored from explore's oracle).
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
    async reLearnStep({ actor, brokenStep, expectedPostcondition, allowedOrigins }) {
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
      });
      return result.outcome === "succeeded"
        ? { outcome: "healed", segment: result.recording }
        : { outcome: "not-healed", reason: `re-learn mission ${result.outcome}` };
    },
  };
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
