import { FixturePathError } from "@jevitate/recording";
import { assertHttpChecksAllowed, HttpCheckOffAllowlistError, parseSuccessSpecUnderSetup } from "../http-probe.js";
import { MissingCredentialError, UsageTracker, type JudgmentPort, type GenerationPort } from "@jevitate/ai-core";
import { FixtureNotFoundError, UnauthorizedExploreTargetError, type SuccessCheck, type SuccessWhen } from "@jevitate/explore";
import { ok, fail } from "../envelope.js";
import { buildMissionFixtures, checkSetupRefs, checkUrlRefOrigin, substituteUrlSetupRefs, setupRefFreeUrl, invariantSetupTexts, substituteSpecSetupRefs, fixtureSetupFailedResult } from "../fixture-cli.js";
import { FixtureSetupError, FixtureSpecError, UnboundSetupRefError, substituteSetupRefs, type MissionFixtures } from "../mission-fixtures.js";
import { withEngine } from "../engine.js";
import { EXIT_CODES } from "../exit-codes.js";
import { runExploration, parseSuccessSpec, resolveExploreAllowlist } from "../explore-api.js";
import { triagedServerLog } from "../explore-shared.js";
import { GatewaySelectionError, buildExploreGateways, resolveJourneysDir } from "../cli-shared.js";
import { resolveJourneyPrefix } from "../journey-prefix.js";
import { GoalRunFlagError, successWhenFromFlags } from "../goal-run-flags.js";
import { resolveCatalogDir } from "../catalog-api.js";
import { exploreDoneCheckPolicy, jobCheckRunOptions, prepareJobDoneCheck, ProjectConfigError, type ExploreJobCheck } from "../explore-job-done-check.js";
import type { DoneCheckPolicy } from "@jevitate/domain";
import type { ExploreRunContext } from "./shared.js";

/** The default goal strategy: `--url` + `--goal` (+ `--success`), with fixtures (moved verbatim out of registerExploreCommands). */
export async function runGoalStrategy(ctx: ExploreRunContext): Promise<void> {
  const { deps, o, warn, emitExplore, target, browser, screenshotsOpt, emulation, withInvariants, serverLog, emitJourneyFailure, withEvidence, runFiling, issueFiler, conversation, secretFields, secretCommand, actors, primaryStorageState, invariants, prefixRequest, typeFixtures, uploadFixtures } = ctx;
  let { journeyPrefix } = ctx;
  // --success may be omitted for a find-out goal (#130d): the run is then verified by a grounded
  // `report` answer (#101) instead of an independent page/network check.
  if (!o.url || !o.goal) {
    emitExplore(fail("E_EXPLORE_ARGS", "--url and --goal are required"));
    return;
  }
  let successChecks: SuccessCheck[];
  try {
    successChecks = o.success.map(parseSuccessSpec);
  } catch (err) {
    emitExplore(fail("E_EXPLORE_ASSERTION", String(err instanceof Error ? err.message : err)));
    return;
  }
  let successWhen: SuccessWhen | undefined;
  try {
    successWhen = successWhenFromFlags(o);
  } catch (err) {
    if (!(err instanceof GoalRunFlagError)) throw err;
    emitExplore(fail(err.code, err.message));
    return;
  }
  const allowlist = resolveExploreAllowlist(setupRefFreeUrl(o.url), o.allow);
  // #543: an http success check reads only an origin the run allows — refused before anything opens.
  try {
    assertHttpChecksAllowed(successChecks, allowlist);
  } catch (err) {
    if (!(err instanceof HttpCheckOffAllowlistError)) throw err;
    emitExplore(fail(err.code, err.message));
    return;
  }
  // Fixtures (#140/#144): the spec and every ${setup.x} reference are validated here, before any
  // browser or request; the setup itself runs just before the mission (below).
  let fx: MissionFixtures | undefined;
  try {
    checkUrlRefOrigin(o.url);
    fx = buildMissionFixtures(o, {
      allowlist,
      baseUrl: setupRefFreeUrl(o.url),
      ...(primaryStorageState === undefined ? {} : { storageState: primaryStorageState }),
      secretFields,
      secrets: o.secret,
      ...(target?.fixtures === undefined ? {} : { targetFixtures: target.fixtures }),
      ...(target?.personas === undefined ? {} : { personas: target.personas }),
    });
    checkSetupRefs({ "--url": o.url, "--goal": o.goal, "--success": o.success, ...invariantSetupTexts(invariants), ...(journeyPrefix === undefined ? {} : { "--param": Object.values(o.param) }) }, fx);
  } catch (err) {
    if (!(err instanceof FixtureSpecError || err instanceof UnboundSetupRefError)) throw err;
    emitExplore(fail(err.code, err.message));
    return;
  }
  // 0.30.0 (#800): the done-check policy (flag over project.json over `require`), refused before any browser.
  const catalogDir = resolveCatalogDir(deps.catalogDir);
  let doneCheckPolicy: DoneCheckPolicy;
  try {
    doneCheckPolicy = exploreDoneCheckPolicy(catalogDir, o.requireDoneCheck);
  } catch (err) {
    if (!(err instanceof ProjectConfigError)) throw err;
    emitExplore(fail(err.code, err.message));
    return;
  }
  const bounds: Record<string, number> = {};
  if (o.maxActions !== undefined) bounds.maxActions = Number(o.maxActions);
  if (o.maxDecisions !== undefined) bounds.maxDecisions = Number(o.maxDecisions);

  let judge: JudgmentPort;
  let gen: GenerationPort;
  let usage: UsageTracker;
  try {
    ({ judge, gen, usage } = await buildExploreGateways(deps, { real: o.real ?? false, fakeAi: o.fakeAi ?? false, jevProvider: o.jevProvider }));
  } catch (err) {
    if (err instanceof MissingCredentialError || err instanceof GatewaySelectionError) {
      emitExplore(fail("E_AI_SETUP_REQUIRED", err.message));
    } else {
      emitExplore(fail("E_EXPLORE_SETUP", String(err instanceof Error ? err.message : err)));
    }
    return;
  }

  let url = o.url;
  let goal = o.goal;
  let runInvariants = withInvariants;
  if (fx !== undefined) {
    // Never run the mission on unknown state: a failed setup ends the run inconclusive (a
    // configuration error), after restoring whatever the partial setup created.
    try {
      await fx.setup();
      const b = fx.bindings();
      url = substituteUrlSetupRefs(o.url, b);
      goal = substituteSetupRefs(o.goal, b, { where: "--goal" });
      successChecks = o.success.map((spec) => parseSuccessSpecUnderSetup(spec, b, "--success"));
      // #187: ${setup.x} in the invariants (probe paths, deniedAs.open, capture routes), origin-fixed.
      if (invariants !== undefined) runInvariants = { ...withInvariants, invariants: substituteSpecSetupRefs(invariants, b, url) };
      // #399: `--param name=${setup.x}` for the Journey prefix is bound to the fixture's output, and the
      // prefix re-resolved so its secret params (and so every redaction) hold the bound value.
      if (journeyPrefix !== undefined && prefixRequest !== undefined && Object.values(o.param).some((v) => v.includes("${setup."))) {
        const params = Object.fromEntries(Object.entries(o.param).map(([k, v]) => [k, substituteSetupRefs(v, b, { where: `--param ${k}` })]));
        // #827: a value a --secret-field bound for the prefix stays (its --param form is the one substituted).
        journeyPrefix = await resolveJourneyPrefix({ ...prefixRequest, params: { ...prefixRequest.params, ...params } });
        o.secret = [...new Set([...o.secret, ...journeyPrefix.secrets])];
      }
    } catch (err) {
      if (!(err instanceof FixtureSetupError || err instanceof UnboundSetupRefError)) {
        await fx.restore();
        throw err;
      }
      await fx.restore();
      emitExplore(ok(withEngine(fixtureSetupFailedResult(err, fx))), EXIT_CODES.inconclusive);
      return;
    }
  }
  // `--job <id>`: the job's done check, read in fresh contexts (before the run, and after each proposed done).
  let jobCheck: ExploreJobCheck | undefined;
  if (o.job !== undefined) {
    try {
      jobCheck = await prepareJobDoneCheck({
        jobId: o.job,
        catalogDir,
        journeysDir: resolveJourneysDir(deps, o.journeysDir),
        startUrl: url,
        ...(primaryStorageState === undefined ? {} : { storageState: primaryStorageState }),
        params: Object.fromEntries(Object.entries(o.param).filter(([, v]) => !o.secret.includes(v) && !v.includes("${"))),
        ...(deps.explore?.browserPortFactory === undefined ? {} : { sessionPortFactory: deps.explore.browserPortFactory }),
      });
    } catch (err) {
      jobCheck = { ok: false, code: "E_EXPLORE_JOB", message: `--job: ${err instanceof Error ? err.message : String(err)}` };
    }
    if (!jobCheck.ok) {
      await fx?.restore();
      emitExplore(fail(jobCheck.code, jobCheck.message));
      return;
    }
  }
  try {
    const result = await runExploration({
      ...(o.renderWaitMs === undefined ? {} : { renderWaitMs: Number(o.renderWaitMs) }),
        ...(target === undefined ? {} : { target }),
      ...jobCheckRunOptions(jobCheck),
      doneCheckPolicy,
      ...(o.requireDoneCheck === true ? { requireDoneCheck: true } : {}),
      url,
      goal,
      successChecks,
      ...(successWhen === undefined ? {} : { successWhen }),
      ...(o.allowVacuousChecks === true ? { allowVacuousChecks: true } : {}),
      ...(o.actionDeltas === true ? { actionDeltas: true } : {}),
      ...(o.blockOffAllowlistNavigation === true ? { blockOffAllowlistNavigation: true } : {}),
      allowlist,
      judge,
      gen,
      usage,
      bounds: Object.keys(bounds).length > 0 ? bounds : undefined,
      ...(o.minActions === undefined && o.minDistinctStates === undefined
        ? {}
        : {
            minEffort: {
              ...(o.minActions === undefined ? {} : { minActions: Number(o.minActions) }),
              ...(o.minDistinctStates === undefined ? {} : { minDistinctStates: Number(o.minDistinctStates) }),
            },
          }),
      secrets: o.secret.length > 0 ? o.secret : undefined,
      ...(secretFields.length > 0 ? { secretFields } : {}),
      ...(secretCommand === undefined ? {} : { secretCommand }),
      ...(o.secretCmdAttempts === undefined ? {} : { secretCommandAttempts: o.secretCmdAttempts }),
      ...(typeFixtures.length > 0 ? { typeFixtures } : {}),
      ...(uploadFixtures.length > 0 ? { uploadFixtures } : {}),
      fixture: o.fixture,
      outDir: o.out,
      browserPortFactory: deps.explore?.browserPortFactory,
      browser,
      ...screenshotsOpt,
      ...(emulation === undefined ? {} : { emulation }),
      ...(primaryStorageState !== undefined ? { storageState: primaryStorageState } : {}),
      ...(o.saveStorageState !== undefined ? { saveStorageState: o.saveStorageState } : {}),
      ...(actors === null ? {} : { actors }),
      ...(runFiling === undefined ? {} : { filing: runFiling }),
      issueFiler,
      ...(o.hangReplays === undefined ? {} : { hangReplays: o.hangReplays }),
      conversation,
      ...runInvariants,
      ...triagedServerLog(serverLog, judge, o.real === true),
      ...(fx === undefined ? {} : { fixtures: fx }),
      ...(journeyPrefix === undefined ? {} : { journeyPrefix }), // #399: re-resolved when a --param was bound
    });
    // 0.30.0 (#800): a pass the model's own goal check alone accepted verified nothing about the job.
    if (result.job?.attainment === "unverified" && result.runOutcome.status === "completed" && result.runOutcome.verifiedBy !== "success-condition") {
      warn(`warning: this pass was judged by the model's goal check alone, so the job is unverified (add --success or --job <id> to verify it)${result.exitCode === EXIT_CODES.inconclusive ? "; exiting 2 (doneCheckPolicy require)" : ""}\n`);
    }
    // 0 succeeded · 1 assertion not met · 2 the run broke (inconclusive/crashed).
    emitExplore(ok(await withEvidence(result)), result.exitCode);
  } catch (err) {
    if (emitJourneyFailure(err)) return;
    if (err instanceof UnauthorizedExploreTargetError) {
      emitExplore(fail("E_UNAUTHORIZED_EXPLORE_TARGET", err.message));
    } else if (err instanceof FixtureNotFoundError || err instanceof FixturePathError) {
      emitExplore(fail("E_EXPLORE_FIXTURE", err.message));
    } else {
      emitExplore(fail("E_EXPLORE_RUN", String(err instanceof Error ? err.message : err)));
    }
  } finally {
    // Every exit path restores the fixture state (a no-op when the mission already did).
    await fx?.restore();
  }
}
