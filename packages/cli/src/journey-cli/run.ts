import { type CliDeps, JEV_PROVIDER_FLAG_HELP, jevProviderArg, resolveDbPath, type BrowserLaunchFlags, withBrowserLaunchFlags, browserRunFromFlags, withDemoFlags, withScreenshotsFlag, type ScreenshotsFlags, type DemoFlags, type EmulationFlags, withEmulationFlags, emulationFromFlags, collectParam, emitJson, environmentSeams, writeRawResult, GatewaySelectionError, buildExploreGateways } from "../cli-shared.js";
import { withProjectFlags } from "../project-layout.js";
import { DEPRECATED_DIR_HELP, journeyLayout } from "./shared.js";
import { HttpCheckOffAllowlistError } from "../http-probe.js";
import { TAG_FLAG, TAG_HELP, collectTag, taggedAction } from "../run-tags-cli.js";
import { existsSync } from "node:fs";
import { Command } from "commander";
import { ParamValidationError } from "@jevitate/journey";
import { MissingCredentialError, UsageTracker, type GenerationPort } from "@jevitate/ai-core";
import { journeyExitCode, safeRunPolicy, type SelfHealMode } from "@jevitate/domain";
import { makeEvidenceSelfHealer } from "../self-heal-adapter.js";
import { CLI_HEAL_NAMES, JourneyHealArgsError, journeyHealBudget, journeyRunSummary, readJourneyChangeScope, validateJourneyHeal, type JourneyHealRequest } from "../journey-heal.js";
import { ChangesArgsError, ChangesInputError } from "../change-context.js";
import { intArg, positiveIntArg } from "../cli-args.js";
import { MAX_STEP_RESPONSE_TIMEOUT_MS } from "../journey-network-checks.js";
import { type ChangeScope, SiteGateRefusedError, type SelfHealer } from "@jevitate/runtime";
import { ok, fail } from "../envelope.js";
import { runJourneyProgrammatically, UnknownJourneyError, JourneyRequiresAuthError } from "../journey-api.js";
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
import { environmentFromFlags, fixtureRebaseUrl, isEnvironmentError, withEnvironmentFlags, withReplayAllowFlag, replayAllowFromFlags, type EnvironmentFlags, type ResolvedJourneyEnvironment } from "../environments.js";

/** Registers `jevitate journey run`. */
export function registerJourneyRun(journey: Command, program: Command, deps: CliDeps): void {
  withScreenshotsFlag(withReplayAllowFlag(withEnvironmentFlags(withDemoFlags(withBrowserLaunchFlags(withEmulationFlags(withFixtureFlags(withProjectFlags(journey.command("run <id>"))))), { recordVideo: true }))))
    .option("--dir <path>", DEPRECATED_DIR_HELP)
    .option("--param <kv>", "param as key=value (repeatable)", collectParam, {} as Record<string, string>)
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
        param,
        storageState: storageStateFlag,
        selfHeal,
        real,
        fakeAi,
        jevProvider,
        json,
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
        storageState?: string;
        selfHeal: string;
        real?: boolean;
        fakeAi?: boolean;
        jevProvider?: string;
        json?: boolean;
      } & EmulationFlags & ScreenshotsFlags>();
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
        let fixtureDrift: FixtureDrift | undefined;
        const result = await withSiteGate(resolveDbPath(deps), (siteGate) => runJourneyProgrammatically({
          ...(siteGate === undefined ? {} : { siteGate }),
          dir: runJourneysDir,
          id,
          params: param,
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
        })).then((r) => withEngine(healUsage === undefined ? r : { ...r, usage: healUsage.snapshot() }));
        if (fixtureDrift !== undefined && !json) program.configureOutput().writeErr?.(`warning: ${(fixtureDrift as FixtureDrift).message}\n`);
        // #246 (informational, never failing): how many steps say why — `journey annotate` drafts the rest.
        const intent = await journeyIntentCoverage(runJourneysDir, id);
        if (intent !== undefined && intent.withoutObjective > 0 && !json) {
          program.configureOutput().writeErr?.(
            `note: ${intent.withoutObjective} of ${intent.steps} step(s) have no objective — draft them with \`jevitate journey annotate ${id}\`\n`,
          );
        }
        const envelope = ok({ ...result, ...(intent === undefined ? {} : { intent }), ...(fixtureDrift === undefined ? {} : { fixtureDrift }) });
        // #583: a declared prepare-only boundary decides the exit too — a run that sent a write is never
        // a pass (`submitted`), and only `prepared` keeps the run's own code.
        const code = handbackExitCode(journeyExitCode(result.outcome), result.handback);
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
        if (err instanceof SiteGateRefusedError || isEnvironmentError(err) || err instanceof HttpCheckOffAllowlistError) {
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
        } else {
          emitJson(program, fail("E_JOURNEY_RUN", String(err)));
        }
      }
    }));
}
