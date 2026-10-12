// ux-usability/loop.ts — phase 2 of `runUsabilityMission` (#500): the model-driven act loop.
import { journeyFixtureBaseDir } from "../journey-api.js";
import { demoOverlayOf } from "../browser-run-options.js";
import { CastActor, BrowseTheWeb } from "@jevitate/screenplay";
import { explore, runGoalBasedMission, type GoalBasedResult, type ExploreConfig, InvariantMonitor, BudgetMonitor } from "@jevitate/explore";
import { conversationConfig } from "../conversation-options.js";
import { startFromJourney } from "../journey-prefix.js";
import type { UsabilitySetup } from "./setup.js";
import { usabilityOnSnapshot } from "./observe.js";

/**
 * Phase 2 — the act loop: the Journey prefix (if any), the budget hooks, then the model-driven loop —
 * through the goal mission's independent adjudication when `successChecks` were given, else
 * `explore()` — and the drained server-log transcript, Recording and transcript written.
 */
export async function runUsabilityLoop(ctx: UsabilitySetup) {
  const { opts, session, origin, serverLog, journalListener, journal, health, uxSecretCommand, fixture, capture } = ctx;
  // #293: a journey-anchored review first replays its Journey's prefix into this very session.
  const start = await startFromJourney(opts.journeyPrefix, session, opts.url, opts.allowlist, opts.browser);
  const actor = CastActor.named("usability-mission").whoCan(new BrowseTheWeb(session, [...opts.allowlist]));
  // #150 — usability's own budget wiring: a plain `InvariantMonitor` reads a budget's declared
  // observables (the same #86/#135 read/auth/redaction machinery), but this mission folds NO
  // invariant defects — only a budget crossing can end the run early, via the same pre-action
  // guard / post-settle hooks `explore()` offers every mission.
  const budgetDecls = opts.invariants?.budget ?? [];
  const invariantMonitor =
    opts.invariants === undefined || budgetDecls.length === 0
      ? null
      : new InvariantMonitor(opts.invariants, {
          allowlist: opts.allowlist,
          baseUrl: opts.url,
          ...(opts.secrets === undefined ? {} : { secrets: opts.secrets }),
          ...(opts.invariantAuthTokens === undefined ? {} : { authTokens: opts.invariantAuthTokens }),
        });
  const budget = invariantMonitor === null ? null : new BudgetMonitor(budgetDecls, invariantMonitor);
  let budgetSettledSteps = 0;
  const exploreCfg: Omit<ExploreConfig, "missionContext"> = {
    ...(opts.target?.timing === undefined ? {} : { timingConfig: opts.target.timing }),
    ...(opts.target?.settle === undefined ? {} : { settle: opts.target.settle }),
    ...(opts.target?.hangs === undefined ? {} : { hangs: opts.target.hangs }),
    ...(opts.target?.safety === undefined ? {} : { safety: opts.target.safety }),
    onTranscriptEntry: serverLog?.onTranscriptEntry ?? journalListener,
    onRecording: journal.onRecording,
    // #303 (opt-in): action deltas, with Jev's advisory relevance labels.
    ...(opts.actionDeltas === true ? { actionDeltas: { jev: true } } : {}),
    hostHealth: health,
    demoOverlay: demoOverlayOf(opts.browser),
    ...(opts.secretFields === undefined ? {} : { secretFields: opts.secretFields }),
    ...(uxSecretCommand === undefined ? {} : { secretCommand: uxSecretCommand }),
    ...(opts.secretCommandAttempts === undefined ? {} : { secretCommandAttempts: opts.secretCommandAttempts }),
    actor,
    judge: opts.judge,
    gen: opts.gen,
    goal: opts.job,
    allowlist: opts.allowlist,
    startUrl: start.url,
    ...(start.branch === undefined ? {} : { startInPlace: true }),
    ...(start.restart === undefined ? {} : { restartAtStart: start.restart.restartAtStart }),
    bounds: opts.bounds,
    secrets: opts.secrets,
    site: origin,
    fixture,
    fixtureRoot: journeyFixtureBaseDir(),
    ...conversationConfig(opts.conversation),
    onSnapshot: usabilityOnSnapshot(ctx),
    ...(budget === null
      ? {}
      : {
          onBeforeAction: async (info) => {
            const g = await budget.guard(session.page, info);
            return g.refuse ? { refuse: true, reason: g.reason ?? "budget guard refused the action" } : { refuse: false };
          },
          onSettled: async () => {
            budgetSettledSteps += 1;
            // The FIRST settled snapshot (before any action) is the budget's baseline.
            if (budgetSettledSteps === 1) {
              const b = await budget.baseline(session.page);
              return b.crossed ? { stop: true, reason: b.reason ?? "budget observable unreadable at run start" } : { stop: false };
            }
            const r = await budget.afterSettle(session.page, budgetSettledSteps);
            return r.crossed ? { stop: true, reason: r.reason ?? "mission budget crossed" } : { stop: false };
          },
        }),
  };
  const brief = "usability review: pursue the stated job as a plausible first-time user, using only what is on screen";
  // #225: `--success` is never ignored — with checks the loop runs through the goal mission's
  // independent adjudication (the same oracle, `held`/vacuous rules and verdict as a goal run).
  const checks = opts.successChecks ?? [];
  const adjudication: GoalBasedResult | undefined =
    checks.length === 0
      ? undefined
      : await runGoalBasedMission({
          ...exploreCfg,
          missionBrief: brief,
          successChecks: checks,
          // #225: a `done` whose check failed on a job judged done ends the run — never the whole budget.
          stopWhenJudgedDone: true,
          ...(opts.successWhen === undefined ? {} : { successWhen: opts.successWhen }),
          ...(opts.allowVacuousChecks === true ? { allowVacuousChecks: true } : {}),
        });
  const run = adjudication?.run ?? (await explore({ ...exploreCfg, missionContext: brief }));
  // Never blocks the mission itself: the drain wait happens AFTER `explore()` returned.
  const serverLogRun = serverLog === undefined ? undefined : await serverLog.finish(run.transcript);
  journal.writeRecording(run.recording);
  journal.writeTranscript(capture.withScreenshots(serverLogRun?.transcript ?? run.transcript));
  return { start, budget, adjudication, run, serverLogRun };
}

export type UsabilityLoop = Awaited<ReturnType<typeof runUsabilityLoop>>;
