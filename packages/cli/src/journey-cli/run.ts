import { type CliDeps, JEV_PROVIDER_FLAG_HELP, jevProviderArg, resolveDbPath, type BrowserLaunchFlags, withBrowserLaunchFlags, browserRunFromFlags, withDemoFlags, withScreenshotsFlag, type ScreenshotsFlags, type DemoFlags, type EmulationFlags, withEmulationFlags, emulationFromFlags, collectParam, emitJson, environmentSeams, writeRawResult, GatewaySelectionError, buildExploreGateways } from "../cli-shared.js";
import { withProjectFlags } from "../project-layout.js";
import { DEPRECATED_DIR_HELP, flaggedCatalogDir, journeyLayout } from "./shared.js";
import { HttpCheckOffAllowlistError } from "../http-probe.js";
import { TAG_FLAG, TAG_HELP, collectTag, taggedAction } from "../run-tags-cli.js";
import { existsSync } from "node:fs";
import { Command, Option } from "commander";
import { FsJourneyStore, ParamValidationError } from "@jevitate/journey";
import { MissingCredentialError, UsageTracker, type GenerationPort } from "@jevitate/ai-core";
import { DEFAULT_DONE_CHECK_POLICY, journeyExitCode, safeRunPolicy, type DoneCheckPolicy, type SelfHealMode } from "@jevitate/domain";
import { makeEvidenceSelfHealer } from "../self-heal-adapter.js";
import { CLI_HEAL_NAMES, JourneyHealArgsError, journeyHealBudget, journeyRunSummary, readJourneyChangeScope, validateJourneyHeal, type JourneyHealRequest } from "../journey-heal.js";
import { ChangesArgsError, ChangesInputError } from "../change-context.js";
import { intArg, positiveIntArg } from "../cli-args.js";
import { MAX_STEP_RESPONSE_TIMEOUT_MS } from "../journey-network-checks.js";
import { type ChangeScope, SiteGateRefusedError, type SelfHealer } from "@jevitate/runtime";
import { ok, fail } from "../envelope.js";
import { evidenceErrorOf, runJourneyProgrammatically, UnknownJourneyError, JourneyRequiresAuthError } from "../journey-api.js";
import { resolveCatalogDir } from "../catalog-api.js";
import { journeyDraftWarning } from "../journey-stale-api.js";
import { draftOnAutomationTargetWarning, RunModeRefusedError } from "../journey-run-mode-gate.js";
import { ParamTypeError, paramTypeRefusalBody } from "../journey-param-types.js";
import { heldOutcomeOf } from "../journey-hold.js";
import { SECRET_MODE_FLAGS, type SecretModeFlag } from "../journey-secret-mode.js";
import { runRecordErrorOf, withJourneyRunRecord } from "../journey-run-record.js";
import { ExtensionMismatchError } from "../browser-run-options.js";
import { parseScreenshotsArg, type ScreenshotsSpec } from "../run-screenshots.js";
import { withSiteGate } from "../site-gate-cli.js";
import { journeyIntentCoverage } from "../journey-annotate-api.js";
import { buildMissionFixtures, checkSetupRefs, withFixtureFlags, type FixtureFlags } from "../fixture-cli.js";
import { FixtureSetupError, FixtureSpecError, UnboundSetupRefError } from "../mission-fixtures.js";
import { withRecordedFixtures, fixtureDriftFor, type FixtureDrift } from "../journey-fixtures.js";
import { withEngine } from "../engine.js";
import { BoundaryNoHealError, handbackExitCode, handbackLine } from "../journey-handback.js";
import { type EmulationSpec } from "@jevitate/playwright";
import { SecretFieldSpecError } from "@jevitate/explore";
import { BoundSecretOutsideFieldError, REPLAY_SECRET_FIELD_HELP, SecretFieldAmbiguousError, withSecretParams, warnSecretParamsOnArgv, type BoundSecretParams } from "../secret-params.js";
import { DoneCheckRun, PlaywrightDoneCheckPort } from "../journey-done-check-hook.js";
import { reconcileLinkedJob } from "../journey-reconcile.js";
import { DONE_CHECK_FAILED_MESSAGE, doneCheckExitInput } from "../journey-done-check.js";
import { loadProjectConfig, ProjectConfigError } from "../project-config.js";
import { environmentFromFlags, fixtureRebaseUrl, isEnvironmentError, withEnvironmentFlags, withReplayAllowFlag, replayAllowFromFlags, type EnvironmentFlags, type ResolvedJourneyEnvironment } from "../environments.js";

/** Registers `jevitate journey run`. */
export function registerJourneyRun(journey: Command, program: Command, deps: CliDeps): void {
  withScreenshotsFlag(withReplayAllowFlag(withEnvironmentFlags(withDemoFlags(withBrowserLaunchFlags(withEmulationFlags(withFixtureFlags(withProjectFlags(journey.command("run <id>"))))), { recordVideo: true }))))
    .option("--dir <path>", DEPRECATED_DIR_HELP)
    .option("--param <kv>", "param as key=value (repeatable); a secret one is on the command line: use --secret-field", collectParam, {} as Record<string, string>)
    .option("--secret-field <binding>", REPLAY_SECRET_FIELD_HELP, (v: string, prev: string[]) => [...prev, v], [] as string[])
    .option(
      "--storage-state <file>",
      "Playwright storageState JSON to start the session authenticated (#118: required when the journey declares metadata.requiresAuth); must exist",
    )
    // Ticket #7 (additive): opt a run into scoped self-healing. Default
    // `fail-closed` preserves Slice 1 behavior exactly (no healer wired). A
    // write/irreversible step NEVER auto-heals in any mode (enforced by the
    // runtime's write floor). `hybrid`/`full` need an AI gateway, selected
    // with --real/--fake-ai (mirrors `explore`); requesting a heal mode
    // without one fails CLOSED, never a silent unhealed run.
    .addOption(
      new Option("--secret-mode <mode>", "0.30.0: how a handback step (or a secret nobody supplied) is met on an automation-mode target: auto (the target's targets.json secretFields type it on its own origin, else the run holds for a person: jevitate inbox resume <holdId> opens it headed) | vault-autofill (the binding, or refuse E_SECRET_MODE_UNAVAILABLE) | visible-handback (always hold for a person) | fail-closed (never wait: quarantine at the step). A test-mode target never waits: E_HUMAN_STEP_IN_TEST_MODE")
        .choices([...SECRET_MODE_FLAGS])
        .default("auto"),
    )
    .option("--self-heal <mode>", "self-heal policy mode: fail-closed | hybrid | full (#453: hybrid/full need --changes and/or --change-note; a heal is proposed for review, exit 5 — never a pass)", "fail-closed")
    .option("--changes <range>", "#453: the git range that explains a break (e.g. HEAD~1..HEAD, main...HEAD; read-only, in the journeys dir's repo) — needs --self-heal hybrid|full")
    .option("--change-note <text>", "#453: a change note that explains a break (e.g. 'renamed \"Create New\" to \"Create\"'; repeatable) — needs --self-heal hybrid|full", (v: string, prev: string[]) => [...prev, v], [] as string[])
    .option("--heal-max-attempts <n>", "#453: candidates tried per broken step (default 2)", positiveIntArg)
    .option("--heal-max-model-calls <n>", "#453: model calls per broken step (default 6)", positiveIntArg)
    .option("--heal-max-ms <ms>", "#453: healing time per broken step in ms (default 60000)", positiveIntArg)
    .option("--heal-max-run-attempts <n>", "#453: candidates tried in the whole run (default 4)", positiveIntArg)
    .option("--heal-max-run-ms <ms>", "#453: healing time in the whole run in ms (default 180000)", positiveIntArg)
    .option("--real", "use live Jev + OpenRouter gateways for self-heal (requires keys)", false)
    .option("--fake-ai", "use deterministic fake gateways for self-heal (pipeline smoke only)", false)
    .option("--jev-provider <provider>", JEV_PROVIDER_FLAG_HELP, jevProviderArg)
    .option("--step-response-timeout <ms>", "#486: how long a step's responseStatus check waits for a matching request that was sent but has no response yet, e.g. a cold start after a deploy (default 15000). A late 2xx is an advisory slow-step finding (slowSteps), not a quarantine; a non-2xx, or no response within the bound, fails. A step's own responseTimeoutMs overrides it; at most 300000", intArg({ min: 1, max: MAX_STEP_RESPONSE_TIMEOUT_MS }))
    .option("--action-deltas", "opt-in (#303): record what each replayed step changed on the page (redacted, a code verdict per step) and compare it with the delta its Recording stored — returned as actionDeltas")
    .option("--no-done-check", "#800: skip the linked job's done check (two fresh-session readings, before step 1 and after the end state); the job reads unverified (basis no-check), which exits 2 unless project.json doneCheckPolicy is advisory")
    .option("--require-done-check", "#800: an unverified job (no done check, or one already true) exits 2 even when project.json doneCheckPolicy is advisory")
    .option("--retry", "#795: this run retries an earlier attempt: the job's done check is read first, in a fresh session, and a job that already reads true is not run again (E_RECONCILE_ALREADY_DONE, exit 2; an unreadable check is E_RECONCILE_UNREADABLE, exit 2)")
    .option("--json", "emit a JSON envelope")
    .option(TAG_FLAG, TAG_HELP, collectTag, [])
    .action(taggedAction(program, "journey run", async function (this: Command, id: string) {
      const locationFlags = this.opts<{ dir?: string; project?: string; journeysDir?: string }>();
      const layout = journeyLayout(program, deps, { dir: locationFlags.dir, project: locationFlags.project, journeysDir: locationFlags.journeysDir });
      if (layout === null) return;
      const runJourneysDir = layout.journeysDir;
      const { env: envName, baseUrl } = this.opts<EnvironmentFlags>();
      // #247: --env/--base-url choose where the Journey runs (unknown env / bad file → 64, nothing opened).
      let environment: ResolvedJourneyEnvironment | undefined;
      let allow: string[];
      try {
        allow = replayAllowFromFlags(this.opts<{ allow: string[] }>().allow);
        environment = environmentFromFlags({ ...(envName === undefined ? {} : { env: envName }), ...(baseUrl === undefined ? {} : { baseUrl }) }, environmentSeams(deps));
      } catch (err) {
        if (!isEnvironmentError(err)) throw err;
        emitJson(program, fail(err.code, err.message));
        return;
      }
      const ownFixtureFlags = this.opts<FixtureFlags>();
      // The environment's fixtures/hooks apply when the flags name none (hooks still need --allow-shell-hooks).
      const fixtureFlags: FixtureFlags = {
        ...ownFixtureFlags,
        ...(ownFixtureFlags.before === undefined && environment?.hooks?.before !== undefined ? { before: environment.hooks.before } : {}),
        ...(ownFixtureFlags.after === undefined && environment?.hooks?.after !== undefined ? { after: environment.hooks.after } : {}),
      };
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
      } = this.opts<{
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
        ({ params: param, bound: boundSecretParams } = await withSecretParams({ dir: runJourneysDir, id, params: paramFlags, flags: secretField, targetFields: environment?.secretFields, targetOrigin: environment?.baseUrl, env: deps.explore?.env ?? process.env }));
      } catch (err) {
        if (err instanceof BoundSecretOutsideFieldError) {
          emitJson(program, fail(err.code, err.message));
          return;
        }
        if (!(err instanceof SecretFieldSpecError || err instanceof SecretFieldAmbiguousError)) throw err;
        emitJson(program, fail("E_JOURNEY_RUN_ARGS", err.message));
        return;
      }
      await warnSecretParamsOnArgv(program.configureOutput().writeErr, runJourneysDir, [id], paramFlags);
      // --storage-state wins; else the environment's own session (~/.jevitate/targets.json[<origin>]).
      const storageState = storageStateFlag ?? environment?.storageState;

      if (storageState !== undefined && !existsSync(storageState)) {
        emitJson(program, fail("E_JOURNEY_RUN_ARGS", `storage state not found: ${storageState}`));
        return;
      }
      // #245: demo mode, resolved (a headed run without a display refused) before any browser opens.
      let browser: ReturnType<typeof browserRunFromFlags>;
      try {
        browser = browserRunFromFlags(this.opts<BrowserLaunchFlags & DemoFlags>(), deps.explore?.env ?? process.env);
      } catch (err) {
        emitJson(program, fail("E_JOURNEY_RUN_ARGS", err instanceof Error ? err.message : String(err)));
        return;
      }
      // #251: an unusable --screenshots value is a usage error (64), before any browser opens.
      let screenshots: ScreenshotsSpec | undefined;
      try {
        screenshots = parseScreenshotsArg(this.opts<ScreenshotsFlags>().screenshots);
      } catch (err) {
        emitJson(program, fail("E_JOURNEY_RUN_ARGS", err instanceof Error ? err.message : String(err)));
        return;
      }
      let journeyRunEmulation: EmulationSpec | undefined;
      try {
        journeyRunEmulation = emulationFromFlags(emulationFlags);
      } catch (err) {
        emitJson(program, fail("E_JOURNEY_RUN_ARGS", err instanceof Error ? err.message : String(err)));
        return;
      }

      if (selfHeal !== "fail-closed" && selfHeal !== "hybrid" && selfHeal !== "full") {
        emitJson(program, fail("E_SELF_HEAL_MODE", `--self-heal must be one of fail-closed | hybrid | full (got '${selfHeal}')`));
        return;
      }
      const selfHealMode = selfHeal as SelfHealMode;
      // #800: the job's done check — its policy from project.json, the flags over it (64 before any browser).
      if (!doneCheck && requireDoneCheck === true) {
        emitJson(program, fail("E_JOURNEY_RUN_ARGS", "--no-done-check and --require-done-check cannot be used together"));
        return;
      }
      const catalogDir = resolveCatalogDir(deps.catalogDir, flaggedCatalogDir(layout));
      let doneCheckPolicy: DoneCheckPolicy;
      try {
        doneCheckPolicy = requireDoneCheck === true ? "require" : (loadProjectConfig(catalogDir).doneCheckPolicy ?? DEFAULT_DONE_CHECK_POLICY);
      } catch (err) {
        if (!(err instanceof ProjectConfigError)) throw err;
        emitJson(program, fail(err.code, err.message));
        return;
      }
      const doneCheckRun = new DoneCheckRun({
        catalogDir,
        journeysDir: runJourneysDir,
        ...(environment?.baseUrl === undefined ? {} : { origin: environment.baseUrl }),
        ...(storageState === undefined ? {} : { storageState }),
        skip: !doneCheck,
        ...(deps.explore?.browserPortFactory === undefined ? {} : { sessionPortFactory: deps.explore.browserPortFactory }),
      });
      // #795: a retry reads the job's done check first (fresh session); a job already done is not run again.
      // A job with no done check proceeds as before.
      if (retry === true) {
        const stored = await new FsJourneyStore(runJourneysDir).get(id);
        if (stored !== null) {
          const origin = environment?.baseUrl ?? stored.recording.site;
          const reconciled = await reconcileLinkedJob({
            catalogDir,
            journeysDir: runJourneysDir,
            journey: stored,
            auth: storageState === undefined ? {} : { storageState },
            origin,
            params: param,
            browserPort: new PlaywrightDoneCheckPort({ origin, ...(deps.explore?.browserPortFactory === undefined ? {} : { sessionPortFactory: deps.explore.browserPortFactory }) }),
          });
          if (!reconciled.proceed) {
            emitJson(program, fail(reconciled.code, reconciled.message));
            return;
          }
        }
      }
      // #453 Q1: a heal needs a change context, and the change/budget flags need a heal — refused
      // (64) before any Journey lookup, git read, model gateway or browser.
      const healRequest: JourneyHealRequest = {
        selfHeal: selfHealMode,
        ...(changes === undefined ? {} : { changes }),
        changeNotes: changeNote,
        ...(healMaxAttempts === undefined ? {} : { maxAttempts: healMaxAttempts }),
        ...(healMaxModelCalls === undefined ? {} : { maxModelCalls: healMaxModelCalls }),
        ...(healMaxMs === undefined ? {} : { maxMs: healMaxMs }),
        ...(healMaxRunAttempts === undefined ? {} : { maxRunAttempts: healMaxRunAttempts }),
        ...(healMaxRunMs === undefined ? {} : { maxRunMs: healMaxRunMs }),
      };
      let healScope: ChangeScope | undefined;
      try {
        validateJourneyHeal(healRequest, CLI_HEAL_NAMES);
        if (selfHealMode !== "fail-closed") healScope = await readJourneyChangeScope(healRequest, runJourneysDir);
      } catch (err) {
        if (err instanceof JourneyHealArgsError || err instanceof ChangesArgsError || err instanceof ChangesInputError) {
          emitJson(program, fail(err.code, err.message));
          return;
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
      if (selfHealMode !== "fail-closed") {
        // #453: the healer is evidence-only — its model is an advisory ranker; judgment never decides a heal.
        let gen: GenerationPort;
        try {
          ({ gen, usage: healUsage } = await buildExploreGateways(deps, { real: real ?? false, fakeAi: fakeAi ?? false, jevProvider }));
        } catch (err) {
          if (err instanceof MissingCredentialError || err instanceof GatewaySelectionError) {
            emitJson(program, fail("E_AI_SETUP_REQUIRED", err.message));
          } else {
            emitJson(program, fail("E_JOURNEY_RUN", String(err instanceof Error ? err.message : err)));
          }
          return;
        }
        selfHealer = makeEvidenceSelfHealer(gen, healUsage === undefined ? {} : { usage: healUsage });
        policy = { ...policy, selfHeal: { mode: selfHealMode, budget: journeyHealBudget(healRequest) } };
      }

      try {
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
        } else if (err instanceof BoundaryNoHealError) {
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
    }));
}
