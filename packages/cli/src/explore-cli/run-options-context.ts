// run-options-context.ts — the ExploreRunContext/modeMeta building stage of `jevitate explore`.
import { existsSync } from "node:fs";
import { Command } from "commander";
import { type InvariantSpec } from "@jevitate/recording";
import { envCredentialStore } from "@jevitate/ai-core";
import { loadLocalCredentials } from "../credentials-file.js";
import { UnauthorizedExploreTargetError, TypeFixtureSpecError, validateAllowControlPatterns, validateDenyPatterns, type SecretField, type TypeFixture, type UploadFixture } from "@jevitate/explore";
import { loadTypeFixtures, loadUploadFixtures } from "../type-fixture-file.js";
import { secretCommandRunner } from "../secret-command.js";
import { ok, fail } from "../envelope.js";
import { InvariantsFileError, loadInvariantFiles, resolveInvariantAuthTokens } from "../invariants-file.js";
import { FilingConfigError, loadFilingFileConfig, resolveFilingConfig } from "../findings-filing.js";
import { fileDraftsWithEvidence } from "../defect-evidence.js";
import { GitHubIssueFiler } from "../github-issue-filer.js";
import { TargetConfigError, loadTargetsFile, resolveTargetConfig, type TargetConfig } from "../target-config.js";
import { setupRefFreeUrl } from "../fixture-cli.js";
import type { FilingConfig, IssueFilerPort } from "@jevitate/domain";
import { withEngine } from "../engine.js";
import { EXIT_CODES } from "../exit-codes.js";
import { resolveExploreAllowlist, type ServerLogOptions } from "../explore-api.js";
import { LogSourceSpecError } from "../log-sources.js";
import { LogClassesError } from "../log-classes.js";
import { LogSpecError } from "../log-lines.js";
import { MultiRunArgsError, projectPersonaFor, type Persona } from "../multi-run.js";
import { authExpiredResult, type AuthCheck, type AuthExpiredResult } from "../persona-login.js";
import { checkActorsAgainstSpec, resolveMissionActors, type MissionActors } from "../mission-actors.js";
import { PlaywrightBrowserPort, type EmulationSpec } from "@jevitate/playwright";
import { type CliDeps, emulationFromFlags, environmentSeams } from "../cli-shared.js";
import { clock } from "@jevitate/domain";
import type { ConversationOptions } from "../conversation-options.js";
import { GoalRunFlagError, conversationFromFlags, secretFieldsFromFlags, targetFlagsFromFlags } from "../goal-run-flags.js";
import { prepareMcpRunGuard, RunGuardRefusedError } from "../mcp-run-guard.js";
import { RunModeRefusedError } from "../journey-run-mode-gate.js";
import { inMcpInvocation } from "../approval-provenance.js";
import { exploreDestructiveRefusal, guardedPortFactory, guardRequestWithMode, resolveSurfaceRunMode, runModeRecord, type SurfaceRunMode } from "../run-surface-mode.js";
import { serverLogOptionsFromFlags, type ExploreOpts, type ExploreRunContext } from "./shared.js";
import type { RunMetadata } from "../run-metadata.js";
import { type ExploreEmit, type ValidatedExploreRun } from "./run-options-validate.js";

/** The pre-run resolution of the explore command: everything the action needs before it dispatches a strategy. */
export interface ExploreRunPreparation {
  /** The resolved context every strategy runner takes. */
  readonly ctx: ExploreRunContext;
  /** #426/0.30.0: the run metadata (the run mode) the dispatch wraps the mission in. */
  readonly modeMeta: Partial<RunMetadata>;
}

/** Builds the typed context and run metadata from the validated flags, in the action's original order. */
export async function buildExploreRunContext(
  program: Command,
  o: ExploreOpts,
  deps: CliDeps,
  emitExplore: ExploreEmit,
  validated: ValidatedExploreRun,
): Promise<ExploreRunPreparation | undefined> {
  const { strategy, dialogs, authCheck, journeyPrefix, prefixRequest, prefixSecretSpecs, withPrefix, withScopeRegion, emitJourneyFailure, browser, screenshotsOpt, sessionPreflight } = validated;
  const policies = resolveExploreConversationAndPolicies(o, emitExplore);
  if (policies === undefined) return;
  const filing = resolveExploreFilingAndEvidence(o, deps, emitExplore, dialogs);
  if (filing === undefined) return;
  if (checkExploreStrategyOptions(o, emitExplore, strategy) === undefined) return;
  const who = resolveExploreActors(o, emitExplore, strategy, authCheck);
  if (who === undefined) return;
  const apps = resolveExploreInvariantsAndLogs(o, emitExplore, strategy, who.actors);
  if (apps === undefined) return;
  const secrets = resolveExploreSecretsAndFixtures(o, emitExplore, strategy, prefixSecretSpecs);
  if (secrets === undefined) return;
  const mode = resolveExploreRunMode(o, deps, emitExplore, prefixRequest);
  if (mode === undefined) return;
  const { actors, primaryStorageState, projectPersona } = who;
  // #427 pre-flight auth check: a run that starts from a session first proves the session is alive
  // (re-minting it once from a persona's login parameters) — else it ends now, `auth-expired`.
  if (primaryStorageState !== undefined) {
    let expired: AuthExpiredResult | undefined;
    try {
      expired = await sessionPreflight(primaryStorageState, actors?.primary ?? projectPersona);
    } catch (err) {
      if (err instanceof UnauthorizedExploreTargetError) emitExplore(fail("E_UNAUTHORIZED_EXPLORE_TARGET", err.message));
      // The check could not open its browser (the mission could not have either): the run did not start.
      else emitExplore(fail("E_EXPLORE_RUN", `the pre-flight auth check failed: ${err instanceof Error ? err.message : String(err)}`));
      return;
    }
    if (expired !== undefined) {
      emitExplore(ok(withEngine(expired)), EXIT_CODES.inconclusive);
      return;
    }
  }

  const ctx: ExploreRunContext = {
    deps: mode.runDeps, o, warn: (line) => void program.configureOutput().writeErr?.(line), emitExplore, strategy, target: filing.target, browser, screenshotsOpt, emulation: policies.emulation, overflow: policies.overflow, withInvariants: apps.withInvariants, serverLog: apps.serverLog, withServerLog: apps.withServerLog, withPrefix, withScopeRegion, emitJourneyFailure, withEvidence: filing.withEvidence, runFiling: filing.runFiling, issueFiler: filing.issueFiler, conversation: policies.conversation, secretFields: secrets.secretFields, secretCommand: secrets.secretCommand, actors: who.actors, primaryStorageState: who.primaryStorageState, invariants: apps.invariants, journeyPrefix, prefixRequest, typeFixtures: secrets.typeFixtures, uploadFixtures: secrets.uploadFixtures,
  };
  return { ctx, modeMeta: mode.modeMeta };
}

/** #210: conversation options and the pre-browser policy refusals (--deny/--paid/--allow-control, --device). */
function resolveExploreConversationAndPolicies(
  o: ExploreOpts,
  emitExplore: ExploreEmit,
): { conversation: ConversationOptions; emulation: EmulationSpec | undefined; overflow: { checkOverflow: boolean; ignoreSelectors: string[] } } | undefined {
  let conversation: ConversationOptions;
  try {
    conversation = conversationFromFlags(o);
  } catch (err) {
    if (!(err instanceof GoalRunFlagError)) throw err;
    emitExplore(fail(err.code, err.message));
    return;
  }
  // #154: refused BEFORE any browser opens — `nonNegativeIntArg` already rejects a bad value at
  // parse time (#275: the value is a number here). 0 is valid: "don't replay" — a hang is then
  // reported unconfirmed (inconclusive), never replayed and never a crash.
  try {
    validateDenyPatterns(o.deny);
    validateDenyPatterns(o.paid, "--paid");
    validateAllowControlPatterns(o.allowControl ?? []);
  } catch (err) {
    emitExplore(fail("E_EXPLORE_ARGS", err instanceof Error ? err.message : String(err)));
    return;
  }
  // #149: refused BEFORE any browser opens (an unknown --device, or --viewport + --device together).
  let emulation: EmulationSpec | undefined;
  try {
    emulation = emulationFromFlags(o);
  } catch (err) {
    emitExplore(fail("E_EXPLORE_ARGS", err instanceof Error ? err.message : String(err)));
    return;
  }
  const overflow = { checkOverflow: o.checkOverflow ?? false, ignoreSelectors: o.ignoreOverflow };
  return { conversation, emulation, overflow };
}

/** Filing configuration, per-target config, the issue filer and the evidence wrapper. */
function resolveExploreFilingAndEvidence(
  o: ExploreOpts,
  deps: CliDeps,
  emitExplore: ExploreEmit,
  dialogs: ValidatedExploreRun["dialogs"],
): { target: TargetConfig | undefined; filing: FilingConfig | undefined; issueFiler: (() => IssueFilerPort) | undefined; runFiling: FilingConfig | undefined; withEvidence: <R extends object>(result: R) => Promise<R> } | undefined {
  // Issue filing: drafts are always written; filing needs --file-issues (or config) AND a repo.
  let filing: FilingConfig | undefined;
  if (o.url !== undefined) {
    try {
      filing = resolveFilingConfig(
        loadFilingFileConfig(deps.explore?.filingConfigPath),
        {
          ...(o.fileIssues === undefined ? {} : { fileIssues: o.fileIssues }),
          ...(o.issueRepo === undefined ? {} : { issueRepo: o.issueRepo }),
          ...(o.jevitateRepo === undefined ? {} : { jevitateRepo: o.jevitateRepo }),
        },
        new URL(setupRefFreeUrl(o.url)).origin,
      );
    } catch (err) {
      if (err instanceof FilingConfigError) {
        emitExplore(fail(err.code, err.message));
        return;
      }
      if (!(err instanceof TypeError)) throw err;
      // An unparseable --url is refused by the authorized-target guard below.
    }
  }
  // Per-target settle/hang configuration: ~/.jevitate/targets.json by origin, plus flags.
  let target: TargetConfig | undefined;
  if (o.url !== undefined) {
    try {
      target = resolveTargetConfig(
        loadTargetsFile(deps.explore?.targetsConfigPath),
        new URL(setupRefFreeUrl(o.url)).origin,
        targetFlagsFromFlags(o, dialogs),
      );
    } catch (err) {
      if (err instanceof TargetConfigError) {
        emitExplore(fail(err.code, err.message));
        return;
      }
      if (!(err instanceof TypeError)) throw err;
    }
  }
  const issueFiler =
    deps.explore?.issueFiler ??
    ((): IssueFilerPort =>
      new GitHubIssueFiler({ store: envCredentialStore(process.env, loadLocalCredentials()) }));
  // #250 --evidence-video: the runner attaches each defect's captioned repro clip + key
  // screenshots; drafts are filed only AFTER their media is linked (the run writes drafts only).
  const evidenceOn = o.evidenceVideo === true;
  const runFiling = filing === undefined ? undefined : evidenceOn ? { ...filing, enabled: false } : filing;
  const withEvidence = async <R extends object>(result: R): Promise<R> => {
    if (!evidenceOn) return result;
    let out = result;
    if (filing?.enabled === true) out = await fileDraftsWithEvidence(out, filing, issueFiler, clock.nowIso());
    return out;
  };
  return { target, filing, issueFiler, runFiling, withEvidence };
}

/** The per-strategy option refusals (--min-actions, --fixture, --product, --success, --job, --action-deltas). */
function checkExploreStrategyOptions(o: ExploreOpts, emitExplore: ExploreEmit, strategy: string): boolean | undefined {
  // `--fixture` feeds the upload op, which only the explore loop (goal and
  // usability strategies) can issue. Refuse it elsewhere rather than
  // silently ignoring a file the user expected to be uploaded.
  // #424: the minimum effort gates the goal loop's own endings (report / blocked / done) — a goal run's.
  if ((o.minActions !== undefined || o.minDistinctStates !== undefined) && (o.feature !== undefined || strategy !== "goal")) {
    emitExplore(fail("E_EXPLORE_ARGS", "--min-actions and --min-distinct-states are supported only with --strategy goal (a goal or find-out run)"));
    return;
  }
  if (o.fixture !== undefined && (o.feature !== undefined || (strategy !== "goal" && strategy !== "usability"))) {
    emitExplore(fail("E_EXPLORE_ARGS", "--fixture is supported only with --strategy goal or usability"));
    return;
  }
  // #198: product facts and polish shape the UX review's findings only.
  if ((o.product !== undefined || o.polish === true || o.probeGuards === true) && (o.feature !== undefined || strategy !== "usability")) {
    emitExplore(fail("E_EXPLORE_ARGS", "--product, --polish and --probe-guards are supported only with --strategy usability"));
    return;
  }
  // #225: success checks judge a goal / a usability job — every other strategy (and --feature) would
  // silently ignore them, so they are refused up front, never dropped.
  if (
    (o.success.length > 0 || o.successWhen !== undefined || o.allowVacuousChecks === true) &&
    (o.feature !== undefined || (strategy !== "goal" && strategy !== "usability"))
  ) {
    emitExplore(
      fail(
        "E_EXPLORE_ARGS",
        `--success, --success-when and --allow-vacuous-checks are supported only with --strategy goal or usability (not ${o.feature !== undefined ? "--feature" : `--strategy ${strategy}`})`,
      ),
    );
    return;
  }
  // 0.30.0 (#800): a job's done check verifies a goal run only — refused elsewhere, never dropped.
  if ((o.job !== undefined || o.requireDoneCheck === true) && (o.feature !== undefined || strategy !== "goal")) {
    emitExplore(fail("E_EXPLORE_ARGS", `--job and --require-done-check are supported only with --strategy goal (not ${o.feature !== undefined ? "--feature" : `--strategy ${strategy}`})`));
    return;
  }
  // #303: action deltas are recorded by the goal loop (goal and usability runs) only — refused
  // elsewhere, never silently ignored.
  if (o.actionDeltas === true && o.feature !== undefined) {
    emitExplore(fail("E_EXPLORE_ARGS", "--action-deltas is not supported with --feature (goal, usability, coverage, exploratory and adversarial runs record deltas)"));
    return;
  }
  return true;
}

/** #427/#147: the project persona, the session's existence and the multi-actor resolution. */
function resolveExploreActors(
  o: ExploreOpts,
  emitExplore: ExploreEmit,
  strategy: string,
  authCheck: AuthCheck,
): { projectPersona: Persona | undefined; actors: MissionActors | null; primaryStorageState: string | undefined } | undefined {
  // #427: the project persona (.jevitate/personas.json) this --storage-state is, when it is one — its
  // session may not exist yet: the pre-flight mints it from its login parameters.
  let projectPersona: Persona | undefined;
  try {
    projectPersona = o.storageState === undefined ? undefined : projectPersonaFor(o.storageState);
  } catch (err) {
    if (!(err instanceof MultiRunArgsError)) throw err;
    emitExplore(fail(err.code, err.message));
    return;
  }
  if (o.storageState !== undefined && !existsSync(o.storageState) && (authCheck.mode === "off" || projectPersona?.login === undefined)) {
    emitExplore(fail("E_EXPLORE_ARGS", `storage state not found: ${o.storageState}`));
    return;
  }
  // Multi-actor missions (#147): the first --actor is the primary, the rest are observers.
  let actors: MissionActors | null;
  try {
    actors = resolveMissionActors(o.actor);
  } catch (err) {
    if (!(err instanceof MultiRunArgsError)) throw err;
    emitExplore(fail(err.code, err.message));
    return;
  }
  if (actors !== null) {
    if (o.feature !== undefined || strategy !== "goal") {
      emitExplore(fail("E_EXPLORE_ARGS", "--actor is supported only with --strategy goal"));
      return;
    }
    if (o.storageState !== undefined) {
      emitExplore(fail("E_EXPLORE_ARGS", "--storage-state cannot be combined with --actor (the first --actor is the primary's session)"));
      return;
    }
  }
  // The primary's session: its --actor state, else --storage-state.
  const primaryStorageState = actors?.primary.storageState ?? o.storageState;
  return { projectPersona, actors, primaryStorageState };
}

/** #86/#142: app-declared invariants and backend log sources, both validated before any browser. */
function resolveExploreInvariantsAndLogs(
  o: ExploreOpts,
  emitExplore: ExploreEmit,
  strategy: string,
  actors: MissionActors | null,
): { invariants: InvariantSpec | undefined; withInvariants: { invariants?: InvariantSpec; invariantAuthTokens?: Map<string, string> }; serverLog: ServerLogOptions | undefined; withServerLog: { serverLog?: ServerLogOptions } } | undefined {
  // App-declared invariants (#86): validated (schema, observables, probe origins) BEFORE any browser.
  let invariants: InvariantSpec | undefined;
  // #135: authFrom.secret refs (env:VAR), resolved from the environment HERE — the one place this
  // package reads process.env for invariants — never inside @jevitate/explore or @jevitate/recording.
  let invariantAuthTokens: Map<string, string> | undefined;
  if (o.invariants.length > 0) {
    if (o.url !== undefined) {
      try {
        const loaded = loadInvariantFiles(o.invariants, {
          allowlist: resolveExploreAllowlist(o.url, o.allow),
          baseUrl: o.url,
          observers: actors?.observers.map((a) => a.name) ?? [],
        });
        invariants = loaded;
        invariantAuthTokens = loaded === undefined ? undefined : resolveInvariantAuthTokens(loaded, process.env);
        checkActorsAgainstSpec(actors, loaded);
      } catch (err) {
        if (err instanceof MultiRunArgsError) {
          emitExplore(fail(err.code, err.message));
          return;
        }
        if (!(err instanceof InvariantsFileError)) throw err;
        emitExplore(fail(err.code, err.message));
        return;
      }
    }
    // #147: captures and cross-actor checks run in the goal loop only — never silently skipped elsewhere.
    if (invariants?.capture !== undefined && (o.feature !== undefined || strategy !== "goal")) {
      emitExplore(fail("E_EXPLORE_ARGS", "invariants with capture (cross-actor checks) are supported only with --strategy goal"));
      return;
    }
  }
  const withInvariants = {
    ...(invariants === undefined ? {} : { invariants }),
    ...(invariantAuthTokens === undefined || invariantAuthTokens.size === 0 ? {} : { invariantAuthTokens }),
  };
  // Backend log sources (#142): validated (spec shape, --allow-log-cmd gate, matcher regexes)
  // BEFORE any browser opens — the same fail-closed discipline as --invariants above. Supported
  // on every strategy, INCLUDING usability (#142 follow-up): lines attach to usability steps the
  // same way, though a UX run's own outcome stays advisory (a server-log defect is still reported,
  // never gates the exit code — the same rule as every other UX finding).
  let serverLog: ServerLogOptions | undefined;
  try {
    // The one builder every surface shares (`explore-cli/shared.ts`): spec shape, the
    // --allow-log-cmd gate, matcher regexes and --log-triage's source requirement, all here
    // before any browser opens.
    serverLog = serverLogOptionsFromFlags(o);
  } catch (err) {
    if (err instanceof LogSourceSpecError || err instanceof LogSpecError || err instanceof LogClassesError || err instanceof GoalRunFlagError) {
      emitExplore(fail(err.code, err.message));
      return;
    }
    throw err;
  }
  const withServerLog = serverLog === undefined ? {} : { serverLog };
  return { invariants, withInvariants, serverLog, withServerLog };
}

/** #72/#281: secret-field bindings, the cmd: secret source and the type/upload fixtures. */
function resolveExploreSecretsAndFixtures(
  o: ExploreOpts,
  emitExplore: ExploreEmit,
  strategy: string,
  prefixSecretSpecs: Set<string>,
): { secretFields: SecretField[]; secretCommand: ReturnType<typeof secretCommandRunner> | undefined; typeFixtures: TypeFixture[]; uploadFixtures: UploadFixture[] } | undefined {
  // Secret field bindings (#72): resolved from the environment here, typed by code in the goal loop.
  let secretFields: SecretField[] = [];
  // #827: a binding the prefix took is not the goal loop's to refuse; a param= one never binds a live field.
  o.secretField = o.secretField.filter((spec) => !(prefixSecretSpecs.has(spec) && (spec.startsWith("param=") || (strategy !== "goal" && strategy !== "usability"))) && !(o.fromJourney !== undefined && spec.startsWith("param=")));
  if (o.secretField.length > 0 || o.totp.length > 0) {
    if (o.feature !== undefined || (strategy !== "goal" && strategy !== "usability")) {
      emitExplore(fail("E_EXPLORE_ARGS", "--secret-field and --totp are supported only with --strategy goal or usability"));
      return;
    }
    try {
      secretFields = secretFieldsFromFlags(o);
    } catch (err) {
      if (!(err instanceof GoalRunFlagError)) throw err;
      emitExplore(fail(err.code, err.message));
      return;
    }
  }

  // #324: a cmd: binding's command runs at type time; its output becomes a run secret at once.
  const secretCommand = secretFields.some((f) => f.kind === "cmd") ? secretCommandRunner() : undefined;

  // #281: fields typed with a file's exact text — read (and checked) before any browser opens.
  let typeFixtures: TypeFixture[] = [];
  let uploadFixtures: UploadFixture[] = [];
  if (o.typeFixture.length > 0) {
    if (o.feature !== undefined || strategy !== "goal") {
      emitExplore(fail("E_EXPLORE_ARGS", "--type-fixture is supported only with --strategy goal"));
      return;
    }
    try {
      typeFixtures = loadTypeFixtures(o.typeFixture);
    } catch (err) {
      if (!(err instanceof TypeFixtureSpecError)) throw err;
      emitExplore(fail(err.code, err.message));
      return;
    }
  }
  if (o.uploadFixture.length > 0) {
    if (o.feature !== undefined || strategy !== "goal") {
      emitExplore(fail("E_EXPLORE_ARGS", "--upload-fixture is supported only with --strategy goal"));
      return;
    }
    try {
      uploadFixtures = loadUploadFixtures(o.uploadFixture);
    } catch (err) {
      if (!(err instanceof TypeFixtureSpecError)) throw err;
      emitExplore(fail(err.code, err.message));
      return;
    }
  }

  // Mission fixtures (#140/#144) run around the goal loop and its replays only.
  const fixtureFlagsGiven = o.fixtures !== undefined || o.before !== undefined || o.after !== undefined;
  if (fixtureFlagsGiven && (o.feature !== undefined || strategy !== "goal")) {
    emitExplore(fail("E_EXPLORE_ARGS", "--fixtures, --before and --after are supported only with --strategy goal, or with --from-journey (any anchored strategy)"));
    return;
  }
  return { secretFields, secretCommand, typeFixtures, uploadFixtures };
}

/** 0.30.0 §5: the surface run mode, its MCP guard wiring and the run-mode metadata. */
function resolveExploreRunMode(
  o: ExploreOpts,
  deps: CliDeps,
  emitExplore: ExploreEmit,
  prefixRequest: ValidatedExploreRun["prefixRequest"],
): { runDeps: CliDeps; modeMeta: Partial<RunMetadata> } | undefined {
  // 0.30.0 §5: the run mode, from the person-written target files only (never an argument), decided
  // before any browser. Over MCP the exploration's own writes go through the #789 guard every Journey
  // run has (each session armed: a production target refused before anything opens, an off-allowlist
  // write refused at the context), given the mode: test mode's relaxation inside the declared
  // environment, automation mode's refusals otherwise. The mode is stamped on the result as `run`.
  let runDeps: CliDeps = deps;
  let decidedMode: SurfaceRunMode | undefined;
  const runModeNotes: string[] = [];
  const startOrigin = ((): string | undefined => {
    try {
      return o.url === undefined ? undefined : new URL(setupRefFreeUrl(o.url)).origin;
    } catch {
      return undefined; // an unparseable --url is refused by the authorized-target guard
    }
  })();
  if (startOrigin !== undefined) {
    try {
      const environment = prefixRequest?.environment;
      decidedMode = resolveSurfaceRunMode({ surface: "explore", origin: startOrigin, environment, ...environmentSeams(deps) });
      const destructive = exploreDestructiveRefusal(decidedMode, o.allowDestructive === true, runModeNotes);
      if (destructive !== undefined) {
        emitExplore(fail(destructive.code, destructive.message));
        return;
      }
      if (inMcpInvocation()) {
        const allowedOrigins = resolveExploreAllowlist(setupRefFreeUrl(o.url!), o.allow);
        const mode = decidedMode;
        const guardFor = () => prepareMcpRunGuard(guardRequestWithMode({ site: startOrigin, allowedOrigins, environment, ...environmentSeams(deps) }, mode, runModeNotes));
        guardFor();
        runDeps = { ...deps, explore: { ...deps.explore, browserPortFactory: guardedPortFactory(deps.explore?.browserPortFactory ?? (() => new PlaywrightBrowserPort()), guardFor) } };
      }
    } catch (err) {
      if (err instanceof RunGuardRefusedError) emitExplore(fail(err.code, err.message));
      else if (err instanceof RunModeRefusedError) emitExplore(fail(err.refusalCode, err.message));
      else emitExplore(fail("E_EXPLORE_ARGS", err instanceof Error ? err.message : String(err)));
      return;
    }
  }
  const modeMeta = decidedMode === undefined ? {} : { runMode: () => runModeRecord(decidedMode!, runModeNotes) };
  return { runDeps, modeMeta };
}
