import { journeyExitCode, journeyMissionOutcome, type DoneCheckPolicy, type MissionOutcome } from "@jevitate/domain";
import type { JobVerdict } from "@jevitate/adjudicator";
import type { Journey } from "@jevitate/journey";
import type { HealReport, JourneyRunResult } from "@jevitate/runtime";
import { redactSecretParams } from "./journey-api.js";
import { journeyStepUrl } from "./check-plan.js";
import { runLocatorHealth } from "./locator-health-api.js";
import { DONE_CHECK_FAILED_MESSAGE, doneCheckExitInput } from "./journey-done-check.js";

/**
 * #453: the `*.result.json` record of one Journey run — what `jevitate report`, the run index and a
 * `check` suite read. Shared by `runJourneyProgrammatically` (a self-heal run persists it) and,
 * once it switches over, `check`. Every string passes `redactSecretParams`.
 */

/** The proposal a `healed-pending-review` run wrote (a person reviews it; the stored Journey is untouched). */
export interface JourneyResultProposal {
  readonly id: string;
  readonly path: string;
  /** The retargeted steps, 1-based, as the review prints them. */
  readonly steps: readonly { readonly number: number; readonly before: string; readonly after: string }[];
  readonly reviewCommand?: string;
  readonly acceptCommand?: string;
}

export interface JourneyResultContext {
  /** The Journey as stored (names the secret params; locates the failing step's page). */
  readonly journey: Journey;
  /** The run's params (secret ones are redacted from the record). */
  readonly params: Readonly<Record<string, string>>;
  readonly startedAt: string;
  readonly engine?: unknown;
  readonly suite?: unknown;
  readonly targetBuild?: unknown;
  readonly proposal?: JourneyResultProposal;
  /** The run's heal report when the result does not already carry it. */
  readonly heal?: HealReport;
  /** #470: the test-id convention for `locatorHealth` (default: the project's config, else data-testid/data-test). */
  readonly testIdAttributes?: readonly string[];
  /** H5: the run's job verdict (its done-check scope's); the record keeps it and folds it into the exit. */
  readonly job?: JobVerdict;
  /** H5: the policy the job folds with (owner decision 3: default `require`). */
  readonly doneCheckPolicy?: DoneCheckPolicy;
}

export interface JourneyResultRecord {
  readonly missionOutcome: MissionOutcome;
  readonly exitCode: number;
  readonly result: Record<string, unknown>;
}

export function journeyResultRecord(r: JourneyRunResult, ctx: JourneyResultContext): JourneyResultRecord {
  const at = r.outcome === "quarantined" || r.outcome === "heal-exhausted" ? r.at : undefined;
  const url = journeyStepUrl(ctx.journey, at);
  const heal = r.heal ?? ctx.heal;
  // #470: how each step's target resolved, and the run's locator health (advisory; never gates here).
  const locatorHealth = runLocatorHealth(ctx.journey, r.resolved, ...(ctx.testIdAttributes === undefined ? [] : [ctx.testIdAttributes]));
  // H5 (owner decisions 2/3): the job verdict folds into the record's outcome and exit as `journey run` folds it.
  const jobInput = doneCheckExitInput(ctx.job, ctx.doneCheckPolicy);
  const failed = r.outcome === "quarantined" || r.outcome === "heal-exhausted";
  const record: JourneyResultRecord = {
    missionOutcome: journeyMissionOutcome(r.outcome, jobInput),
    exitCode: journeyExitCode(r.outcome, jobInput),
    result: {
      mode: "journey",
      journeyId: ctx.journey.metadata.id,
      outcome: r.outcome,
      ...(failed ? { reason: r.reason, ...(r.at === undefined ? {} : { at: r.at }) } : {}),
      ...(ctx.job === undefined ? {} : { job: ctx.job }),
      ...(ctx.job?.attainment === "not-achieved" && !failed ? { failure: { kind: "done-check-failed", message: DONE_CHECK_FAILED_MESSAGE } } : {}),
      ...(url === undefined ? {} : { url }),
      ...(heal === undefined ? {} : { heal }),
      ...(ctx.proposal === undefined ? {} : { proposal: ctx.proposal }),
      startedAt: ctx.startedAt,
      target: { seedUrl: ctx.journey.recording.site, allowlist: [new URL(ctx.journey.recording.site).origin] },
      ...(ctx.engine === undefined ? {} : { engine: ctx.engine }),
      ...(ctx.suite === undefined ? {} : { suite: ctx.suite }),
      ...(ctx.targetBuild === undefined ? {} : { targetBuild: ctx.targetBuild }),
      ...(r.resolved === undefined ? {} : { resolved: r.resolved }),
      ...(locatorHealth === undefined ? {} : { locatorHealth }),
    },
  };
  return redactSecretParams(record, ctx.journey, ctx.params);
}
