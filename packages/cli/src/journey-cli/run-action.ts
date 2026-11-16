// journey-cli/run-action.ts — the `journey run` action handler, moved out of `registerJourneyRun`
// and split into named phase helpers (environment, flags, policy, heal, execute, error report).
import type { Command } from "commander";
import { existsSync } from "node:fs";
import { FsJourneyStore, ParamValidationError } from "@jevitate/journey";
import { MissingCredentialError, type GenerationPort, type UsageTracker } from "@jevitate/ai-core";
import { DEFAULT_DONE_CHECK_POLICY, journeyExitCode, safeRunPolicy, type DoneCheckPolicy, type SelfHealMode } from "@jevitate/domain";
import { type ChangeScope, SiteGateRefusedError, type SelfHealer } from "@jevitate/runtime";
import { type EmulationSpec } from "@jevitate/playwright";
import { SecretFieldSpecError } from "@jevitate/explore";
import {
  type BrowserLaunchFlags,
  type CliDeps,
  type DemoFlags,
  type EmulationFlags,
  GatewaySelectionError,
  type ScreenshotsFlags,
  browserRunFromFlags,
  buildExploreGateways,
  emitJson,
  emulationFromFlags,
  environmentSeams,
  resolveDbPath,
  writeRawResult,
} from "../cli-shared.js";
import { flaggedCatalogDir, journeyLayout } from "./shared.js";
import { HttpCheckOffAllowlistError } from "../http-probe.js";
import { ok, fail } from "../envelope.js";
import { makeEvidenceSelfHealer } from "../self-heal-adapter.js";
import { CLI_HEAL_NAMES, JourneyHealArgsError, journeyHealBudget, journeyRunSummary, readJourneyChangeScope, validateJourneyHeal, type JourneyHealRequest } from "../journey-heal.js";
import { ChangesArgsError, ChangesInputError } from "../change-context.js";
import { evidenceErrorOf, runJourneyProgrammatically, UnknownJourneyError, JourneyRequiresAuthError } from "../journey-api.js";
import { resolveCatalogDir } from "../catalog-api.js";
import { journeyDraftWarning } from "../journey-stale-api.js";
import { draftOnAutomationTargetWarning, RunModeRefusedError } from "../journey-run-mode-gate.js";
import { ParamTypeError, paramTypeRefusalBody } from "../journey-param-types.js";
import { heldOutcomeOf } from "../journey-hold.js";
import { type SecretModeFlag } from "../journey-secret-mode.js";
import { runRecordErrorOf, withJourneyRunRecord } from "../journey-run-record.js";
import { ExtensionMismatchError } from "../browser-run-options.js";
import { parseScreenshotsArg, type ScreenshotsSpec } from "../run-screenshots.js";
import { withSiteGate } from "../site-gate-cli.js";
import { journeyIntentCoverage } from "../journey-annotate-api.js";
import { buildMissionFixtures, checkSetupRefs, type FixtureFlags } from "../fixture-cli.js";
import { FixtureSetupError, FixtureSpecError, UnboundSetupRefError } from "../mission-fixtures.js";
import { withRecordedFixtures, fixtureDriftFor, type FixtureDrift } from "../journey-fixtures.js";
import { withEngine } from "../engine.js";
import { BoundaryNoHealError, handbackExitCode, handbackLine } from "../journey-handback.js";
import { BoundSecretOutsideFieldError, SecretFieldAmbiguousError, withSecretParams, warnSecretParamsOnArgv, type BoundSecretParams } from "../secret-params.js";
import { DoneCheckRun, PlaywrightDoneCheckPort } from "../journey-done-check-hook.js";
import { reconcileLinkedJob } from "../journey-reconcile.js";
import { DONE_CHECK_FAILED_MESSAGE, doneCheckExitInput } from "../journey-done-check.js";
import { loadProjectConfig, ProjectConfigError } from "../project-config.js";
import { environmentFromFlags, fixtureRebaseUrl, isEnvironmentError, replayAllowFromFlags, type EnvironmentFlags, type ResolvedJourneyEnvironment } from "../environments.js";

/** Phase 1: where the run lives and which environment (its file / base URL / allowlist) applies. */
async function resolveRunEnvironment(command: Command, program: Command, deps: CliDeps) {
  const locationFlags = command.opts<{ dir?: string; project?: string; journeysDir?: string }>();
  const layout = journeyLayout(program, deps, { dir: locationFlags.dir, project: locationFlags.project, journeysDir: locationFlags.journeysDir });
  if (layout === null) return undefined;
  const runJourneysDir = layout.journeysDir;
  const { env: envName, baseUrl } = command.opts<EnvironmentFlags>();
  // #247: --env/--base-url choose where the Journey runs (unknown env / bad file → 64, nothing opened).
  let environment: ResolvedJourneyEnvironment | undefined;
  let allow: string[];
  try {
    allow = replayAllowFromFlags(command.opts<{ allow: string[] }>().allow);
    environment = environmentFromFlags({ ...(envName === undefined ? {} : { env: envName }), ...(baseUrl === undefined ? {} : { baseUrl }) }, environmentSeams(deps));
  } catch (err) {
    if (!isEnvironmentError(err)) throw err;
    emitJson(program, fail(err.code, err.message));
    return undefined;
  }
  const ownFixtureFlags = command.opts<FixtureFlags>();
  // The environment's fixtures/hooks apply when the flags name none (hooks still need --allow-shell-hooks).
  const fixtureFlags: FixtureFlags = {
    ...ownFixtureFlags,
    ...(ownFixtureFlags.before === undefined && environment?.hooks?.before !== undefined ? { before: environment.hooks.before } : {}),
    ...(ownFixtureFlags.after === undefined && environment?.hooks?.after !== undefined ? { after: environment.hooks.after } : {}),
  };
  return { layout, runJourneysDir, environment, allow, fixtureFlags };
}
type RunEnvironment = NonNullable<Awaited<ReturnType<typeof resolveRunEnvironment>>>;

/** Phase 2: the run's flags — secrets, storage state, browser/demo, screenshots and emulation, all resolved before any browser. */
async function resolveRunInputs(command: Command, program: Command, deps: CliDeps, id: string, env: RunEnvironment) {
  const {
    param: paramFlags,
    secretField,
    secretMode,
    storageState: storageStateFlag,
    selfHeal,
    real,
    fakeAi,
    jevProvider,
    json,
    doneCheck,
    requireDoneCheck,
    retry,
    screenshots: _screenshots,
    actionDeltas,
    stepResponseTimeout,
    changes,
    changeNote,
    healMaxAttempts,
    healMaxModelCalls,
    healMaxMs,
    healMaxRunAttempts,
    healMaxRunMs,
    ...emulationFlags
  } = command.opts<{
    changes?: string;
    changeNote: string[];
    healMaxAttempts?: number;
    healMaxModelCalls?: number;
    healMaxMs?: number;
    healMaxRunAttempts?: number;
    healMaxRunMs?: number;
    actionDeltas?: boolean;
    stepResponseTimeout?: number;
    param: Record<string, string>;
    secretField: string[];
    secretMode: SecretModeFlag;
    storageState?: string;
    selfHeal: string;
    real?: boolean;
    fakeAi?: boolean;
    jevProvider?: string;
    json?: boolean;
    doneCheck: boolean;
    requireDoneCheck?: boolean;
    retry?: boolean;
  } & EmulationFlags & ScreenshotsFlags>();
  // A secret parameter from the environment (--secret-field, targets.json), before any browser opens.
  let param: Record<string, string>;
  let boundSecretParams: BoundSecretParams | undefined;
  try {
    ({ params: param, bound: boundSecretParams } = await withSecretParams({ dir: env.runJourneysDir, id, params: paramFlags, flags: secretField, targetFields: env.environment?.secretFields, targetOrigin: env.environment?.baseUrl, env: deps.explore?.env ?? process.env }));
  } catch (err) {
    if (err instanceof BoundSecretOutsideFieldError) {
      emitJson(program, fail(err.code, err.message));
      return undefined;
    }
    if (!(err instanceof SecretFieldSpecError || err instanceof SecretFieldAmbiguousError)) throw err;
    emitJson(program, fail("E_JOURNEY_RUN_ARGS", err.message));
    return undefined;
  }
  await warnSecretParamsOnArgv(program.configureOutput().writeErr, env.runJourneysDir, [id], paramFlags);
  // --storage-state wins; else the environment's own session (~/.jevitate/targets.json[<origin>]).
  const storageState = storageStateFlag ?? env.environment?.storageState;

  if (storageState !== undefined && !existsSync(storageState)) {
    emitJson(program, fail("E_JOURNEY_RUN_ARGS", `storage state not found: ${storageState}`));
    return undefined;
  }
  // #245: demo mode, resolved (a headed run without a display refused) before any browser opens.
  let browser: ReturnType<typeof browserRunFromFlags>;
  try {
    browser = browserRunFromFlags(command.opts<BrowserLaunchFlags & DemoFlags>(), deps.explore?.env ?? process.env);
  } catch (err) {
    emitJson(program, fail("E_JOURNEY_RUN_ARGS", err instanceof Error ? err.message : String(err)));
    return undefined;
  }
  // #251: an unusable --screenshots value is a usage error (64), before any browser opens.
  let screenshots: ScreenshotsSpec | undefined;
  try {
    screenshots = parseScreenshotsArg(command.opts<ScreenshotsFlags>().screenshots);
  } catch (err) {
    emitJson(program, fail("E_JOURNEY_RUN_ARGS", err instanceof Error ? err.message : String(err)));
    return undefined;
  }
  let journeyRunEmulation: EmulationSpec | undefined;
  try {
    journeyRunEmulation = emulationFromFlags(emulationFlags);
  } catch (err) {
    emitJson(program, fail("E_JOURNEY_RUN_ARGS", err instanceof Error ? err.message : String(err)));
    return undefined;
  }
  return {
    paramFlags,
    secretField,
    param,
    boundSecretParams,
    secretMode,
    storageState,
    browser,
    screenshots,
    journeyRunEmulation,
    selfHeal,
    real,
    fakeAi,
    jevProvider,
    json,
    doneCheck,
    requireDoneCheck,
    retry,
    actionDeltas,
    stepResponseTimeout,
    changes,
    changeNote,
    healMaxAttempts,
    healMaxModelCalls,
    healMaxMs,
    healMaxRunAttempts,
    healMaxRunMs,
  };
}
type RunInputs = NonNullable<Awaited<ReturnType<typeof resolveRunInputs>>>;

/** Phase 3: the self-heal mode, the job's done-check policy, and a retry's reconcile. */
async function resolveRunPolicy(program: Command, deps: CliDeps, id: string, env: RunEnvironment, inputs: RunInputs) {
  if (inputs.selfHeal !== "fail-closed" && inputs.selfHeal !== "hybrid" && inputs.selfHeal !== "full") {
    emitJson(program, fail("E_SELF_HEAL_MODE", `--self-heal must be one of fail-closed | hybrid | full (got '${inputs.selfHeal}')`));
    return undefined;
  }
  const selfHealMode = inputs.selfHeal as SelfHealMode;
  // #800: the job's done check — its policy from project.json, the flags over it (64 before any browser).
  if (!inputs.doneCheck && inputs.requireDoneCheck === true) {
    emitJson(program, fail("E_JOURNEY_RUN_ARGS", "--no-done-check and --require-done-check cannot be used together"));
    return undefined;
  }
  const catalogDir = resolveCatalogDir(deps.catalogDir, flaggedCatalogDir(env.layout));
  let doneCheckPolicy: DoneCheckPolicy;
  try {
    doneCheckPolicy = inputs.requireDoneCheck === true ? "require" : (loadProjectConfig(catalogDir).doneCheckPolicy ?? DEFAULT_DONE_CHECK_POLICY);
  } catch (err) {
    if (!(err instanceof ProjectConfigError)) throw err;
    emitJson(program, fail(err.code, err.message));
    return undefined;
  }
  const doneCheckRun = new DoneCheckRun({
    catalogDir,
    journeysDir: env.runJourneysDir,
    ...(env.environment?.baseUrl === undefined ? {} : { origin: env.environment.baseUrl }),
    ...(inputs.storageState === undefined ? {} : { storageState: inputs.storageState }),
    skip: !inputs.doneCheck,
    ...(deps.explore?.browserPortFactory === undefined ? {} : { sessionPortFactory: deps.explore.browserPortFactory }),
    // H5: a self-heal run's result record folds its job with the same policy as this exit.
    policy: doneCheckPolicy,
  });
  // #795: a retry reads the job's done check first (fresh session); a job already done is not run again.
  // A job with no done check proceeds as before.
  if (inputs.retry === true) {
    const stored = await new FsJourneyStore(env.runJourneysDir).get(id);
    if (stored !== null) {
      const origin = env.environment?.baseUrl ?? stored.recording.site;
      const reconciled = await reconcileLinkedJob({
        catalogDir,
        journeysDir: env.runJourneysDir,
        journey: stored,
        auth: inputs.storageState === undefined ? {} : { storageState: inputs.storageState },
        origin,
        params: inputs.param,
        browserPort: new PlaywrightDoneCheckPort({ origin, ...(deps.explore?.browserPortFactory === undefined ? {} : { sessionPortFactory: deps.explore.browserPortFactory }) }),
      });
      if (!reconciled.proceed) {
        emitJson(program, fail(reconciled.code, reconciled.message));
        return undefined;
      }
    }
  }
  return { selfHealMode, catalogDir, doneCheckPolicy, doneCheckRun };
}
type RunPolicyBundle = NonNullable<Awaited<ReturnType<typeof resolveRunPolicy>>>;

/** Phase 4: the change context a heal needs, the self-healer, and its budget. */
async function resolveRunHeal(program: Command, deps: CliDeps, env: RunEnvironment, inputs: RunInputs, policyBundle: RunPolicyBundle) {
  // #453 Q1: a heal needs a change context, and the change/budget flags need a heal — refused
  // (64) before any Journey lookup, git read, model gateway or browser.
  const healRequest: JourneyHealRequest = {
    selfHeal: policyBundle.selfHealMode,
    ...(inputs.changes === undefined ? {} : { changes: inputs.changes }),
    changeNotes: inputs.changeNote,
    ...(inputs.healMaxAttempts === undefined ? {} : { maxAttempts: inputs.healMaxAttempts }),
    ...(inputs.healMaxModelCalls === undefined ? {} : { maxModelCalls: inputs.healMaxModelCalls }),
    ...(inputs.healMaxMs === undefined ? {} : { maxMs: inputs.healMaxMs }),
    ...(inputs.healMaxRunAttempts === undefined ? {} : { maxRunAttempts: inputs.healMaxRunAttempts }),
    ...(inputs.healMaxRunMs === undefined ? {} : { maxRunMs: inputs.healMaxRunMs }),
  };
  let healScope: ChangeScope | undefined;
  try {
    validateJourneyHeal(healRequest, CLI_HEAL_NAMES);
    if (policyBundle.selfHealMode !== "fail-closed") healScope = await readJourneyChangeScope(healRequest, env.runJourneysDir);
  } catch (err) {
    if (err instanceof JourneyHealArgsError || err instanceof ChangesArgsError || err instanceof ChangesInputError) {
      emitJson(program, fail(err.code, err.message));
      return undefined;
    }
    throw err;
  }

  // When a heal mode is requested, build the SelfHealer HERE (this action
  // owns `deps` + the credential preflight); a missing/unselected gateway
  // fails CLOSED before any browser launch, rather than silently running
  // with no healer. fail-closed needs no gateway (identical to today).
  let selfHealer: SelfHealer | undefined;
  let policy = safeRunPolicy();
  // #163: a self-healing run makes model calls — their usage (and full cost) lands on its result.
  let healUsage: UsageTracker | undefined;
  if (policyBundle.selfHealMode !== "fail-closed") {
    // #453: the healer is evidence-only — its model is an advisory ranker; judgment never decides a heal.
    let gen: GenerationPort;
    try {
      ({ gen, usage: healUsage } = await buildExploreGateways(deps, { real: inputs.real ?? false, fakeAi: inputs.fakeAi ?? false, jevProvider: inputs.jevProvider }));
    } catch (err) {
      if (err instanceof MissingCredentialError || err instanceof GatewaySelectionError) {
        emitJson(program, fail("E_AI_SETUP_REQUIRED", err.message));
      } else {
        emitJson(program, fail("E_JOURNEY_RUN", String(err instanceof Error ? err.message : err)));
      }
      return undefined;
    }
    selfHealer = makeEvidenceSelfHealer(gen, healUsage === undefined ? {} : { usage: healUsage });
    policy = { ...policy, selfHeal: { mode: policyBundle.selfHealMode, budget: journeyHealBudget(healRequest) } };
  }
  return { healScope, selfHealer, policy, healUsage };
}
type RunHealBundle = NonNullable<Awaited<ReturnType<typeof resolveRunHeal>>>;

/** Phase 5: record the run and replay the Journey inside its done-check scope. */
async function replayJourney(program: Command, deps: CliDeps, id: string, env: RunEnvironment, inputs: RunInputs, policyBundle: RunPolicyBundle, healBundle: RunHealBundle) {
  const { runJourneysDir, environment, allow, fixtureFlags } = env;
  const { param, boundSecretParams, secretMode, storageState, browser, screenshots, journeyRunEmulation, actionDeltas, stepResponseTimeout } = inputs;
  const { doneCheckRun } = policyBundle;
  const { healScope, selfHealer, policy, healUsage } = healBundle;
  // `runJourneyProgrammatically` validates params UP FRONT (before any
  // browser launch). The default policy stays `safeRunPolicy()`
  // (fail-closed secret mode) — only `selfHeal.mode` is threaded from
  // the flag; a `--secret-mode` override is a later slice's concern.
  // #544: no --fixtures → the Journey's recorded fixtures (a missing file is refused before any browser).
  const recorded = await withRecordedFixtures(fixtureFlags, { dir: runJourneysDir, id });
  // #788: a draft runs here, as authoring needs, and says once what MCP would answer.
  const unapproved = await journeyDraftWarning(runJourneysDir, id, resolveCatalogDir(deps.catalogDir));
  if (unapproved !== undefined) program.configureOutput().writeErr?.(unapproved);
  // 0.30.0 §5.7: a draft on an automation-mode target (anything not declared trust test or harness) says so once.
  const draftOnAutomation = await draftOnAutomationTargetWarning({ journeysDir: runJourneysDir, id, environment, targetsFile: environmentSeams(deps).targetsFile });
  if (draftOnAutomation !== undefined) program.configureOutput().writeErr?.(draftOnAutomation);
  let fixtureDrift: FixtureDrift | undefined;
  // #790: every run leaves one value-free record, whatever it comes to.
  const result = await doneCheckRun.run(() => withJourneyRunRecord({ channel: "cli", id, params: param, logsRoot: deps.logs?.logsRoot, job: () => doneCheckRun.job }, (runRecorder) => withSiteGate(resolveDbPath(deps), (siteGate) => runJourneyProgrammatically({
      runRecorder,
      ...(siteGate === undefined ? {} : { siteGate }),
      dir: runJourneysDir,
      id,
      params: param,
      ...(boundSecretParams === undefined ? {} : { boundSecretParams }),
      secretMode,
      ...(deps.explore?.env === undefined ? {} : { secretEnv: deps.explore.env }),
      policy,
      selfHealer,
      ...(healScope === undefined ? {} : { heal: { scope: healScope } }),
      browserPortFactory: deps.explore?.browserPortFactory,
      ...(browser === undefined ? {} : { browser }),
      ...(journeyRunEmulation === undefined ? {} : { emulation: journeyRunEmulation }),
      ...(screenshots === undefined ? {} : { screenshots }),
      ...(storageState !== undefined ? { storageState } : {}),
      ...(actionDeltas === true ? { actionDeltas: true } : {}),
      ...(stepResponseTimeout === undefined ? {} : { stepResponseTimeoutMs: stepResponseTimeout }),
      ...(environment === undefined ? {} : { environment }),
      // 0.30.0 §5: the operator's targets file the run's trust is read from (the #789 guard's seam).
      ...(environmentSeams(deps).targetsFile === undefined ? {} : { runGuardTargetsFile: environmentSeams(deps).targetsFile }),
      ...(allow.length === 0 ? {} : { allow }),
      // #140: fixture HTTP steps may only reach the replay's allowlist (authenticated from --storage-state):
      // the journey's own site (#247: under an environment, its allowed origins), plus (#542/#543) its
      // recorded metadata.allowedOrigins and --allow — so a fixture can reset an http check's outbox.
      fixtures: (site, allowedOrigins, sourceSite) => {
        // #543: the replay's effective allowlist (#542), so a fixture can reset an allowed outbox.
        fixtureDrift = fixtureDriftFor(recorded.recorded, { allowlist: [...allowedOrigins], baseUrl: site });
        // #561: fixture step URLs on a named secondary origin move with the environment's origins.
        const rebaseUrl = fixtureRebaseUrl(environment, sourceSite);
        const fx = buildMissionFixtures(recorded.flags, {
          allowlist: [...allowedOrigins],
          baseUrl: site,
          ...(rebaseUrl === undefined ? {} : { rebaseUrl }),
          ...(storageState !== undefined ? { storageState } : {}),
          ...(environment?.fixtures === undefined ? {} : { targetFixtures: environment.fixtures }),
        });
        checkSetupRefs({ "--param": Object.values(param) }, fx);
        return fx;
      },
    })))).then((r) => withEngine(healUsage === undefined ? r : { ...r, usage: healUsage.snapshot() }));
  return { result, fixtureDrift };
}

/** Phase 6: report the run's envelope and exit code. */
async function executeJourneyRun(program: Command, deps: CliDeps, id: string, env: RunEnvironment, inputs: RunInputs, policyBundle: RunPolicyBundle, healBundle: RunHealBundle): Promise<void> {
  const { runJourneysDir } = env;
  const { json } = inputs;
  const { doneCheckRun, doneCheckPolicy, selfHealMode } = policyBundle;
  try {
    const { result, fixtureDrift } = await replayJourney(program, deps, id, env, inputs, policyBundle, healBundle);
    if (result.runRecordError !== undefined) program.configureOutput().writeErr?.(`warning: ${result.runRecordError}\n`);
    if (result.evidenceError !== undefined) program.configureOutput().writeErr?.(`warning: ${result.evidenceError}\n`);
    if (fixtureDrift !== undefined && !json) program.configureOutput().writeErr?.(`warning: ${(fixtureDrift as FixtureDrift).message}\n`);
    // #246 (informational, never failing): how many steps say why — `journey annotate` drafts the rest.
    const intent = await journeyIntentCoverage(runJourneysDir, id);
    if (intent !== undefined && intent.withoutObjective > 0 && !json) {
      program.configureOutput().writeErr?.(
        `note: ${intent.withoutObjective} of ${intent.steps} step(s) have no objective — draft them with \`jevitate journey annotate ${id}\`\n`,
      );
    }
    // #800: the job verdict (absent while the done-check hooks are not registered: the run is unchanged).
    const job = doneCheckRun.job;
    const doneCheckFailed = job?.attainment === "not-achieved" && !("failure" in result);
    const envelope = ok({
      ...result,
      ...(job === undefined ? {} : { job }),
      ...(doneCheckFailed ? { failure: { kind: "done-check-failed", message: DONE_CHECK_FAILED_MESSAGE } } : {}),
      ...(intent === undefined ? {} : { intent }),
      ...(fixtureDrift === undefined ? {} : { fixtureDrift }),
    });
    // #583: a declared prepare-only boundary decides the exit too — a run that sent a write is never
    // a pass (`submitted`), and only `prepared` keeps the run's own code.
    // #800 (owner decisions 2/3): a job not achieved exits 1; an unverified pass exits 2 under `require`.
    const code = handbackExitCode(journeyExitCode(result.outcome, doneCheckExitInput(job, doneCheckPolicy)), result.handback);
    if (json) {
      emitJson(program, envelope);
      // #453: ok → 0; healed-pending-review → 5 (a proposed revision, never a pass); else 1.
      if (code !== 0) process.exitCode = code;
    } else {
      writeRawResult(program, envelope.data);
      // #453: a self-heal run also says, in words, what happened and what a person does next.
      if (selfHealMode !== "fail-closed") program.configureOutput().writeErr?.(journeyRunSummary(id, result));
      if (result.handback !== undefined) program.configureOutput().writeOut?.(`${handbackLine(result.handback)}\n`);
      process.exitCode = code;
    }
  } catch (err) {
    handleJourneyRunError(program, err);
  }
}

/** The run's failures: a problem on the way it was recorded, or the typed refusal it met. */
function handleJourneyRunError(program: Command, err: unknown): void {
  const recordProblem = runRecordErrorOf(err);
  if (recordProblem !== undefined) program.configureOutput().writeErr?.(`warning: ${recordProblem}\n`);
  const evidenceProblem = evidenceErrorOf(err);
  if (evidenceProblem !== undefined) program.configureOutput().writeErr?.(`warning: ${evidenceProblem}\n`);
  const held = heldOutcomeOf(err);
  if (held !== undefined) {
    // 0.30.0 §5.4: held for a person (`jevitate inbox approve <holdId>`); it proves nothing yet (exit 2).
    emitJson(program, ok(withEngine(held)));
    process.exitCode = 2;
  } else if (err instanceof SiteGateRefusedError || isEnvironmentError(err) || err instanceof HttpCheckOffAllowlistError) {
    emitJson(program, fail(err.code, err.message));
  } else if (err instanceof UnknownJourneyError) {
    emitJson(program, fail("E_UNKNOWN_JOURNEY", String(err.message)));
  } else if (err instanceof JourneyRequiresAuthError) {
    emitJson(program, fail("E_JOURNEY_REQUIRES_AUTH", String(err.message)));
  } else if (err instanceof ExtensionMismatchError) {
    emitJson(program, fail(err.code, err.message));
  } else if (err instanceof FixtureSetupError) {
    // Never run on unknown state: inconclusive, a configuration error (exit 2).
    emitJson(
      program,
      ok(withEngine({ outcome: "inconclusive", reason: err.message, failure: { kind: "configuration", message: err.message }, attribution: "configuration" })),
    );
    process.exitCode = 2;
  } else if (err instanceof FixtureSpecError || err instanceof UnboundSetupRefError) {
    emitJson(program, fail(err.code, err.message));
  } else if (err instanceof BoundaryNoHealError || err instanceof BoundSecretOutsideFieldError) {
    emitJson(program, fail(err.code, err.message));
  } else if (err instanceof ParamValidationError) {
    emitJson(program, fail("E_INVALID_PARAMS", String(err.message)));
  } else if (err instanceof ParamTypeError) {
    // #796: names and expected types only, never a value; exit 64.
    const body = paramTypeRefusalBody(err);
    emitJson(program, fail(body.code, body.message));
  } else if (err instanceof RunModeRefusedError) {
    // 0.30.0 §5: a test-mode target never waits for a person (exit 2, refused).
    emitJson(program, fail(err.refusalCode, err.message));
  } else {
    emitJson(program, fail("E_JOURNEY_RUN", String(err)));
  }
}

/** The `journey run` action handler body, moved out of `registerJourneyRun`. */
export async function runJourneyRunAction(command: Command, program: Command, deps: CliDeps, id: string): Promise<void> {
  const env = await resolveRunEnvironment(command, program, deps);
  if (env === undefined) return;
  const inputs = await resolveRunInputs(command, program, deps, id, env);
  if (inputs === undefined) return;
  const policyBundle = await resolveRunPolicy(program, deps, id, env, inputs);
  if (policyBundle === undefined) return;
  const healBundle = await resolveRunHeal(program, deps, env, inputs, policyBundle);
  if (healBundle === undefined) return;
  await executeJourneyRun(program, deps, id, env, inputs, policyBundle, healBundle);
}
