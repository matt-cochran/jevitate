import { taggedAction } from "../run-tags-cli.js";
import { existsSync } from "node:fs";
import { Command } from "commander";
import { type InvariantSpec, type TargetDescriptor } from "@jevitate/recording";
import { envCredentialStore } from "@jevitate/ai-core";
import { loadLocalCredentials } from "../credentials-file.js";
import { UnauthorizedExploreTargetError, TypeFixtureSpecError, validateAllowControlPatterns, validateDenyPatterns, type DialogPolicy, type SecretField, type TypeFixture } from "@jevitate/explore";
import { loadTypeFixtures } from "../type-fixture-file.js";
import { secretCommandRunner } from "../secret-command.js";
import { ok, fail, type JsonEnvelope } from "../envelope.js";
import { SessionFileInProjectError, assertSessionFileOutsideProject } from "../project-dir.js";
import { InvariantsFileError, loadInvariantFiles, resolveInvariantAuthTokens } from "../invariants-file.js";
import { FilingConfigError, loadFilingFileConfig, resolveFilingConfig } from "../findings-filing.js";
import { fileDraftsWithEvidence } from "../defect-evidence.js";
import { parseScreenshotsArg, type ScreenshotsSpec } from "../run-screenshots.js";
import { GitHubIssueFiler } from "../github-issue-filer.js";
import { TargetConfigError, loadTargetsFile, resolveTargetConfig, type TargetConfig } from "../target-config.js";
import { setupRefFreeUrl } from "../fixture-cli.js";
import type { FilingConfig, IssueFilerPort } from "@jevitate/domain";
import { LITERAL_SECRET_WARNING, SecretArgError, resolveSecretArgs } from "../secret-args.js";
import { withEngine } from "../engine.js";
import { setKillSwitchOutput } from "../kill-signal.js";
import { EXIT_CODES } from "../exit-codes.js";
import { nonNegativeIntArg } from "../cli-args.js";
import { formatMissionHuman, formatMultiRunHuman } from "../cli-output.js";
import { resolveExploreAllowlist, type ServerLogOptions } from "../explore-api.js";
import { LogSourceSpecError } from "../log-sources.js";
import { LogClassesError } from "../log-classes.js";
import { LogSpecError } from "../log-lines.js";
import { MultiRunArgsError, projectPersonaFor, resolveMultiRunPlan, wantsMultiRun, type Persona } from "../multi-run.js";
import { authExpiredResult, ensurePersonaSession, LoginArgsError, parseAuthCheck, type AuthCheck, type AuthExpiredResult } from "../persona-login.js";
import { MultiRunAbortedError, runExploreMultiRun } from "../multi-run-cli.js";
import { checkActorsAgainstSpec, resolveMissionActors, type MissionActors } from "../mission-actors.js";
import { PlaywrightBrowserPort, type EmulationSpec } from "@jevitate/playwright";
import { type CliDeps, browserRunFromFlags, emulationFromFlags, emitCommandResult, environmentSeams, resolveDbPath, resolveJourneysDir, resolveMissionTargetsDir, EXPLORE_STRATEGIES } from "../cli-shared.js";
import { allowWithExtensions, assertExtensionTargetLoaded, multiWindowWarning } from "../browser-run-options.js";
import { ParamValidationError } from "@jevitate/journey";
import { SiteGateRefusedError } from "@jevitate/runtime";
import { JourneyRequiresAuthError, UnknownJourneyError } from "../journey-api.js";
import { environmentFromFlags, isEnvironmentError } from "../environments.js";
import { resolve as resolvePath } from "node:path";
import { CAMPAIGN_LIMITS, isSweepMode } from "@jevitate/journey";
import { CampaignSpecError, runCampaign, validateCampaignSpec } from "../campaign-api.js";
import { formatCampaignHuman } from "../campaign-cli.js";
import { forwardedArgv } from "../multi-run-cli.js";
import { resolveScopeRegions } from "./scope-region.js";
import { ANCHORED_STRATEGIES, JourneyPrefixArgsError, JourneyPrefixStaleError, journeyStaleResult, resolveJourneyPrefix, type JourneyPrefix } from "../journey-prefix.js";
import { clock } from "@jevitate/domain";
import type { ConversationOptions } from "../conversation-options.js";
import { GoalRunFlagError, conversationFromFlags, dialogsFromFlags, secretFieldsFromFlags, targetFlagsFromFlags } from "../goal-run-flags.js";
import { declareExploreCommand } from "./options.js";
import { runCoverageStrategy } from "./coverage-strategy.js";
import { runAdversarialStrategy } from "./adversarial-strategy.js";
import { runUsabilityStrategy } from "./usability-strategy.js";
import { runFeatureStrategy } from "./feature-strategy.js";
import { runGoalStrategy } from "./goal-strategy.js";
import { AUTH_PREFLIGHT_TIMEOUT_MS, SWEEP_OWNED, fixtureBoundUrlRoot, serverLogOptionsFromFlags, type ExploreOpts, type ExploreRunContext } from "./shared.js";

/**
 * Registers `jevitate explore` (every strategy: goal, coverage, exploratory, adversarial, usability, feature, multi-run).
 * `buildProgram` builds a fresh program for each run of a multi-run (#141/#143).
 */
export function registerExploreRun(program: Command, deps: CliDeps, buildProgram: (deps: CliDeps) => Command): void {
  declareExploreCommand(program)
    .action(taggedAction(program, "explore", async function (this: Command) {
      const o = this.opts<ExploreOpts>();
      // #210: one output rule for every strategy — the envelope with --json, a human summary without.
      const emitExplore = (envelope: JsonEnvelope<unknown>, exitCode?: number, human: (data: unknown) => string = formatMissionHuman): void =>
        emitCommandResult(program, envelope, { json: o.json === true, command: "explore", human, ...(exitCode === undefined ? {} : { exitCode }) });

      // #230: an unknown --strategy must be refused before any other required-option message — it
      // would otherwise fall through to the default goal-strategy path and silently run a goal
      // mission. Checked first, ahead of every other validation below.
      if (o.strategy !== undefined && !EXPLORE_STRATEGIES.includes(o.strategy as (typeof EXPLORE_STRATEGIES)[number])) {
        emitExplore(fail("E_EXPLORE_ARGS", `unknown strategy ${JSON.stringify(o.strategy)} (one of ${EXPLORE_STRATEGIES.join(", ")})`));
        return;
      }
      // #334: a mistyped --dialogs never silently means "dismiss".
      let dialogs: DialogPolicy | undefined;
      try {
        dialogs = dialogsFromFlags(o);
      } catch (err) {
        if (!(err instanceof GoalRunFlagError)) throw err;
        emitExplore(fail(err.code, err.message));
        return;
      }

      // #427: an unusable --auth-check is a usage error, refused before anything runs.
      let authCheck: AuthCheck;
      try {
        authCheck = parseAuthCheck(o.authCheck);
      } catch (err) {
        if (!(err instanceof LoginArgsError)) throw err;
        emitExplore(fail("E_EXPLORE_ARGS", err.message));
        return;
      }

      // #195: a session file never lands in the repo's .jevitate/ (refused before any run, multi-runs included).
      if (o.saveStorageState !== undefined) {
        try {
          assertSessionFileOutsideProject(o.saveStorageState, "--save-storage-state");
        } catch (err) {
          if (!(err instanceof SessionFileInProjectError)) throw err;
          emitExplore(fail(err.code, err.message));
          return;
        }
      }
      const strategy = o.strategy ?? "goal";
      // #519: --scope-region on a strategy without a coverage gate, or one that does not parse, is refused up front
      // (also ahead of a --at-step sweep, whose per-stop runs would each refuse it).
      try {
        resolveScopeRegions({ scopeRegion: o.scopeRegion, strategy, ...(o.feature === undefined ? {} : { feature: o.feature }), ...(o.goal === undefined ? {} : { goal: o.goal }) });
      } catch (err) {
        emitExplore(fail("E_EXPLORE_ARGS", err instanceof Error ? err.message : String(err)));
        return;
      }
      // #293 journey-anchored exploration: the Journey, step, params and environment are resolved (and
      // refused, exit 64) before anything else — the start URL every later check uses is where the
      // Journey's prefix lands.
      let journeyPrefix: JourneyPrefix | undefined;
      /** #399: how the prefix was resolved — re-resolved once `${setup.x}` in a --param is bound (goal + --fixtures). */
      let prefixRequest: Parameters<typeof resolveJourneyPrefix>[0] | undefined;
      const anchoredFlags = [o.fromJourney, o.atStep, o.journeysDir, o.env, o.baseUrl].some((v) => v !== undefined);
      if (anchoredFlags || Object.keys(o.param).length > 0) {
        const refuse = (message: string): void => emitExplore(fail("E_EXPLORE_ARGS", message));
        if (o.fromJourney === undefined || o.atStep === undefined) {
          refuse("--from-journey and --at-step go together (and --param, --env, --base-url and --journeys-dir need them)");
          return;
        }
        if (o.url !== undefined) {
          refuse("--url cannot be combined with --from-journey: the mission starts where the Journey's prefix leaves the page");
          return;
        }
        if (o.feature !== undefined || !(ANCHORED_STRATEGIES as readonly string[]).includes(strategy)) {
          refuse(`--from-journey supports --strategy ${ANCHORED_STRATEGIES.join(", ")} (not --feature)`);
          return;
        }
        if (wantsMultiRun(o) || o.actor.length > 0) {
          refuse("--from-journey runs one anchored mission: --repeat, --persona, --personas and --actor are not supported with it (a campaign runs several)");
          return;
        }
        // #293 sweep: `--at-step all|anchors` runs the strategy from EVERY step (or anchor), each in a
        // fresh session with --fixtures restored around it, --max-actions/--max-decisions split evenly
        // over the stop points, and reads them as one deduped report (a one-job campaign).
        // #312: one anchored step with a state restore (--fixtures/--before/--after) on a non-goal
        // strategy runs the same way — as a one-stop campaign, whose runner restores around the run.
        const restoredSingle =
          !isSweepMode(o.atStep) && strategy !== "goal" && (o.fixtures !== undefined || o.before !== undefined || o.after !== undefined);
        if ((isSweepMode(o.atStep) || restoredSingle) && Object.values(o.param).some((v) => v.includes("${setup."))) {
          refuse("a --param holding ${setup.x} is bound from --fixtures only by a single --strategy goal run; pass the value itself here");
          return;
        }
        if (isSweepMode(o.atStep) || restoredSingle) {
          if (o.real !== true && o.fakeAi !== true) {
            emitExplore(fail("E_AI_SETUP_REQUIRED", "a sweep's missions are model-driven: pass --real or --fake-ai"));
            return;
          }
          const journeysDir = resolveJourneysDir(deps, o.journeysDir);
          const abs = (p: string): string => resolvePath(p);
          const spec = {
            version: 1,
            name: restoredSingle ? `${o.fromJourney} at step ${o.atStep.trim()} (${strategy}, restored)` : `sweep of ${o.fromJourney} (${o.atStep}, ${strategy})`,
            ...(o.env === undefined ? {} : { env: o.env }),
            ...(o.baseUrl === undefined ? {} : { baseUrl: o.baseUrl }),
            ...(o.storageState === undefined ? {} : { storageState: abs(o.storageState) }),
            ...(o.fixtures === undefined ? {} : { fixtures: abs(o.fixtures) }),
            ...(o.before === undefined ? {} : { before: o.before }),
            ...(o.after === undefined ? {} : { after: o.after }),
            discovery: false,
            maxRuns: CAMPAIGN_LIMITS.maxRuns,
            jobs: [
              {
                id: "sweep",
                journey: o.fromJourney,
                params: o.param,
                anchors: restoredSingle ? [o.atStep.trim()] : o.atStep.trim(),
                strategies: [strategy],
                ...(o.goal === undefined ? {} : { goal: o.goal }),
                ...(o.appClass === undefined ? {} : { appClass: o.appClass }),
                ...(o.success.length === 0 ? {} : { success: o.success }),
                ...(o.maxActions === undefined ? {} : { maxActions: Number(o.maxActions) }),
                ...(o.maxDecisions === undefined ? {} : { maxDecisions: Number(o.maxDecisions) }),
              },
            ],
          };
          try {
            const plan = await validateCampaignSpec(spec, resolvePath("explore-sweep.json"), {
              journeysDir,
              allowShellHooks: o.allowShellHooks === true,
              ...(o.hookTimeoutMs === undefined ? {} : { hookTimeoutMs: Number(o.hookTimeoutMs) }),
              environmentSeams: environmentSeams(deps),
            });
            const result = await runCampaign(plan, {
              newProgram: () => buildProgram(deps),
              journeysDir,
              missionTargetsDir: resolveMissionTargetsDir(deps),
              ...(o.out === undefined ? {} : { outDir: o.out }),
              ...(o.real === true ? { real: true } : {}),
              ...(o.fakeAi === true ? { fakeAi: true } : {}),
              missionArgs: forwardedArgv(this, SWEEP_OWNED),
            });
            emitExplore(ok(withEngine({ sweep: { journeyId: o.fromJourney, mode: restoredSingle ? "step" : o.atStep.trim(), ...(restoredSingle ? { atStep: o.atStep.trim() } : {}), strategy, stops: plan.totalRuns, budgetPerStop: { maxActions: plan.jobs[0]?.maxActions, ...(plan.jobs[0]?.maxDecisions === undefined ? {} : { maxDecisions: plan.jobs[0].maxDecisions }) } }, ...result })), result.exitCode, formatCampaignHuman);
          } catch (err) {
            if (err instanceof CampaignSpecError) emitExplore(fail("E_EXPLORE_ARGS", err.message));
            else emitExplore(fail("E_EXPLORE_RUN", String(err instanceof Error ? err.message : err)));
          }
          return;
        }
        try {
          const environment = environmentFromFlags(
            { ...(o.env === undefined ? {} : { env: o.env }), ...(o.baseUrl === undefined ? {} : { baseUrl: o.baseUrl }) },
            environmentSeams(deps),
          );
          // The environment's own session applies when --storage-state names none (as `journey run`).
          if (o.storageState === undefined && environment?.storageState !== undefined) o.storageState = environment.storageState;
          prefixRequest = {
            dir: resolveJourneysDir(deps, o.journeysDir),
            id: o.fromJourney,
            atStep: o.atStep,
            params: o.param,
            ...(environment === undefined ? {} : { environment }),
            ...(o.storageState === undefined ? {} : { storageState: o.storageState }),
            dbPath: resolveDbPath(deps),
            environmentFlags: { ...(o.env === undefined ? {} : { env: o.env }), ...(o.baseUrl === undefined ? {} : { baseUrl: o.baseUrl }) },
          };
          journeyPrefix = await resolveJourneyPrefix(prefixRequest);
        } catch (err) {
          if (isEnvironmentError(err) || err instanceof JourneyPrefixArgsError) emitExplore(fail(err.code, err.message));
          else if (err instanceof UnknownJourneyError) emitExplore(fail("E_UNKNOWN_JOURNEY", err.message));
          else if (err instanceof ParamValidationError) emitExplore(fail("E_INVALID_PARAMS", err.message));
          else if (err instanceof JourneyRequiresAuthError) emitExplore(fail("E_JOURNEY_REQUIRES_AUTH", err.message));
          else emitExplore(fail("E_EXPLORE_ARGS", err instanceof Error ? err.message : String(err)));
          return;
        }
        // The prefix types its secret params into the page the mission perceives: they are redacted like
        // --secret. Coverage/exploratory carry no redaction set, so a prefix with secrets refuses them.
        if (journeyPrefix.secrets.length > 0 && (strategy === "coverage" || strategy === "exploratory")) {
          refuse(`journey '${o.fromJourney}' types a secret param before step ${journeyPrefix.branch.step}: --strategy ${strategy} cannot redact it — use goal, adversarial or usability`);
          return;
        }
        o.url = journeyPrefix.startUrl;
        // Default allowlist: the origins the Journey's steps may be on (the environment's), not just the landing's.
        if (o.allow.length === 0) o.allow = [...journeyPrefix.allowedOrigins];
      }
      const withPrefix = journeyPrefix === undefined ? {} : { journeyPrefix };
      // #519: the scope region — the anchor's (authoritative) or --scope-region's — resolved and refused before any browser opens.
      let withScopeRegion: { scopeRegions?: TargetDescriptor[]; scopeRegionSpec?: string };
      try {
        const region = resolveScopeRegions({ scopeRegion: o.scopeRegion, strategy, ...(o.feature === undefined ? {} : { feature: o.feature }), ...(o.goal === undefined ? {} : { goal: o.goal }) }, journeyPrefix);
        withScopeRegion = region === undefined ? {} : { scopeRegions: region.descriptors, scopeRegionSpec: region.spec };
      } catch (err) {
        emitExplore(fail("E_EXPLORE_ARGS", err instanceof Error ? err.message : String(err)));
        return;
      }
      /** #293: a prefix that no longer replays, or a site policy that refused it — typed, handled once for every strategy. */
      const emitJourneyFailure = (err: unknown): boolean => {
        if (err instanceof JourneyPrefixStaleError) {
          emitExplore(ok(withEngine(journeyStaleResult(err, strategy))), EXIT_CODES.inconclusive);
          return true;
        }
        if (err instanceof SiteGateRefusedError) {
          emitExplore(fail(err.code, err.message));
          return true;
        }
        return false;
      };
      // #195: `--secret env:VAR` is resolved from the environment before anything runs (fail closed).
      try {
        const resolved = resolveSecretArgs(o.secret, process.env, "--secret");
        if (resolved.literals > 0) program.configureOutput().writeErr?.(LITERAL_SECRET_WARNING);
        o.secret = [...resolved.secrets, ...(journeyPrefix?.secrets ?? [])];
      } catch (err) {
        if (!(err instanceof SecretArgError)) throw err;
        emitExplore(fail("E_EXPLORE_ARGS", err.message));
        return;
      }
      // #245 demo mode: resolved (and a headed run without a display refused, exit 64) before any
      // browser opens — a multi-run's every run re-resolves the same flags.
      let browser: ReturnType<typeof browserRunFromFlags>;
      try {
        browser = browserRunFromFlags(o, deps.explore?.env ?? process.env);
        // #256: a chrome-extension:// --url must be a loaded extension's; loaded extensions' origins are allowed.
        assertExtensionTargetLoaded(o.url, browser);
        o.allow = allowWithExtensions(o.url, o.allow, browser);
      } catch (err) {
        emitExplore(fail("E_EXPLORE_ARGS", err instanceof Error ? err.message : String(err)));
        return;
      }
      // #251: an unusable --screenshots value is a usage error (64), refused before any browser opens.
      let screenshots: ScreenshotsSpec | undefined;
      try {
        screenshots = parseScreenshotsArg(o.screenshots);
      } catch (err) {
        emitExplore(fail("E_EXPLORE_ARGS", err instanceof Error ? err.message : String(err)));
        return;
      }
      // #251/#250: the capture options every strategy's runner takes.
      const screenshotsOpt = { ...(screenshots === undefined ? {} : { screenshots }), ...(o.evidenceVideo === true ? { evidenceVideo: true } : {}) };
      if (browser?.headed === true && (wantsMultiRun(o) || o.actor.length > 1)) {
        program.configureOutput().writeErr?.(multiWindowWarning(o.actor.length > 1 ? "several --actor sessions" : "--repeat/--persona"));
      }
      /**
       * #427: the pre-flight auth check of one session — undefined when it is alive (or refreshed, or
       * not checked: --auth-check off, no --url, a --from-journey run whose prefix replay is its own
       * check), or the `auth-expired` result when it is not. Throws `UnauthorizedExploreTargetError`.
       */
      const sessionPreflight = async (storageState: string, persona: Persona | undefined): Promise<AuthExpiredResult | undefined> => {
        if (authCheck.mode === "off" || o.url === undefined || journeyPrefix !== undefined) return undefined;
        const allowlist = resolveExploreAllowlist(o.url, o.allow);
        // A start URL bound from --fixtures (`${setup.x}`) does not exist before the setup runs: the
        // check opens the app's root instead (the mission itself starts after the setup, as before).
        const checkUrl = o.url.includes("${") ? fixtureBoundUrlRoot(o.url) : o.url;
        if (checkUrl === undefined) return undefined; // no origin before the placeholder: the mission's own URL check refuses it
        const r = await ensurePersonaSession({
          ...(persona === undefined ? {} : { persona: persona.name }),
          ...(persona?.login === undefined ? {} : { login: persona.login }),
          storageState,
          url: checkUrl,
          allowlist,
          check: authCheck,
          port: (deps.explore?.browserPortFactory ?? (() => new PlaywrightBrowserPort()))(),
          ...(browser === undefined ? {} : { browser }),
          env: deps.explore?.env ?? process.env,
          timeoutMs: AUTH_PREFLIGHT_TIMEOUT_MS,
          note: (line) => program.configureOutput().writeErr?.(line),
        });
        return r.ok ? undefined : authExpiredResult(strategy, o.url, r, persona?.name);
      };
      // Repeat-and-vote (#141) / persona matrix (#143): the same command, run sequentially and aggregated.
      if (wantsMultiRun(o)) {
        try {
          const plan = resolveMultiRunPlan(o);
          const result = await runExploreMultiRun({
            cmd: this,
            newProgram: () => buildProgram(deps),
            plan,
            strategy,
            ...(o.out === undefined ? {} : { out: o.out }),
            // #220: a killed multi-run prints ITS partial summary, by this command's own output rule.
            killOutput: (partial) => (o.json === true ? `${JSON.stringify(ok(withEngine(partial)))}\n` : formatMultiRunHuman(partial)),
            // #427: each run's session (its persona's, or the mission's own) is checked before it starts.
            ...(authCheck.mode === "off"
              ? {}
              : {
                  authPreflight: async (p: Persona | undefined) => {
                    const state = p?.storageState ?? o.storageState;
                    if (state === undefined) return undefined;
                    const r = await sessionPreflight(state, p ?? projectPersonaFor(state));
                    return r === undefined ? undefined : withEngine(r);
                  },
                }),
          });
          emitExplore(ok(withEngine(result)), result.exitCode, formatMultiRunHuman);
        } catch (err) {
          if (err instanceof MultiRunArgsError) emitExplore(fail(err.code, err.message));
          else if (err instanceof UnauthorizedExploreTargetError) emitExplore(fail("E_UNAUTHORIZED_EXPLORE_TARGET", err.message));
          else if (err instanceof MultiRunAbortedError) emitExplore(fail(err.envelope.error.code, err.envelope.error.message));
          else emitExplore(fail("E_EXPLORE_RUN", String(err instanceof Error ? err.message : err)));
        }
        return;
      }
      // #120: a killed run prints what this command would have printed — the envelope with --json,
      // else the human summary (#210) — before it exits.
      setKillSwitchOutput(o.json === true ? "envelope" : "human");
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
      // #303: action deltas are recorded by the goal loop (goal and usability runs) only — refused
      // elsewhere, never silently ignored.
      if (o.actionDeltas === true && o.feature !== undefined) {
        emitExplore(fail("E_EXPLORE_ARGS", "--action-deltas is not supported with --feature (goal, usability, coverage, exploratory and adversarial runs record deltas)"));
        return;
      }
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
      // Secret field bindings (#72): resolved from the environment here, typed by code in the goal loop.
      let secretFields: SecretField[] = [];
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

      // Mission fixtures (#140/#144) run around the goal loop and its replays only.
      const fixtureFlagsGiven = o.fixtures !== undefined || o.before !== undefined || o.after !== undefined;
      if (fixtureFlagsGiven && (o.feature !== undefined || strategy !== "goal")) {
        emitExplore(fail("E_EXPLORE_ARGS", "--fixtures, --before and --after are supported only with --strategy goal, or with --from-journey (any anchored strategy)"));
        return;
      }

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
        deps, o, emitExplore, strategy, target, browser, screenshotsOpt, emulation, overflow, withInvariants, serverLog, withServerLog, withPrefix, withScopeRegion, emitJourneyFailure, withEvidence, runFiling, issueFiler, conversation, secretFields, secretCommand, actors, primaryStorageState, invariants, journeyPrefix, prefixRequest, typeFixtures,
      };

      if (strategy === "coverage" || strategy === "exploratory") {
        await runCoverageStrategy({ ...ctx, strategy });
        return;
      }
      if (strategy === "adversarial") {
        await runAdversarialStrategy(ctx);
        return;
      }
      if (strategy === "usability") {
        await runUsabilityStrategy(ctx);
        return;
      }
      if (o.feature) {
        await runFeatureStrategy(ctx);
        return;
      }
      await runGoalStrategy(ctx);
    }));
}
