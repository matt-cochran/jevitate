import { existsSync } from "node:fs";
import type { Command } from "commander";
import { ParamValidationError } from "@jevitate/journey";
import { ok, fail } from "../envelope.js";
import { resolveCatalogDir } from "../catalog-api.js";
import { SiteGateRefusedError } from "@jevitate/runtime";
import {
  type BrowserLaunchFlags,
  type CliDeps,
  type DemoFlags,
  type EmulationFlags,
  browserRunFromFlags,
  collectParam,
  emitJson,
  emulationFromFlags,
  environmentSeams,
  resolveDbPath,
  withBrowserLaunchFlags,
  withEmulationFlags,
} from "../cli-shared.js";
import { intArg } from "../cli-args.js";
import { MAX_STEP_RESPONSE_TIMEOUT_MS } from "../journey-network-checks.js";
import { ExtensionMismatchError } from "../browser-run-options.js";
import { HttpCheckOffAllowlistError } from "../http-probe.js";
import { ProofHoldRefusedError } from "../journey-run-hooks.js";
import { withSiteGate } from "../site-gate-cli.js";
import { REPLAY_SECRET_FIELD_HELP, collectSecretField, secretFieldErrorOf, warnSecretParamsOnArgv, withCommandSecretParams, type BoundSecretParams } from "../secret-params.js";
import { environmentFromFlags, fixtureRebaseUrl, isEnvironmentError, replayAllowFromFlags, withEnvironmentFlags, withReplayAllowFlag, type EnvironmentFlags, type ResolvedJourneyEnvironment } from "../environments.js";
import { EXIT_CODES } from "../exit-codes.js";
import { buildMissionFixtures, checkSetupRefs, withFixtureFlags, type FixtureFlags } from "../fixture-cli.js";
import { FixtureSetupError, FixtureSpecError, UnboundSetupRefError } from "../mission-fixtures.js";
import { withRecordedFixtures } from "../journey-fixtures.js";
import { JourneyRequiresAuthError, UnknownJourneyError } from "../journey-api.js";
import { JourneyShortenError, SHORTEST_FOUND, shortenJourney, type ShortenJourneyReport } from "../journey-shorten.js";
import { withEngine } from "../engine.js";
import { withProjectFlags } from "../project-layout.js";
import { flaggedCatalogDir, journeyLayout, targetsOpts } from "./shared.js";

/** The one summary line: always "shortest found within budget", never "optimal". */
export function shortenLine(r: ShortenJourneyReport): string {
  if (r.stopped === "recorded-path-fails") {
    return `nothing shortened — journey '${r.journeyId}': the recorded path did not achieve job '${r.job}' (${r.baseline}) in ${r.replaysUsed} replay, so no shorter path was tried`;
  }
  const head = `${SHORTEST_FOUND} — journey '${r.journeyId}': ${r.originalSteps} → ${r.shortestSteps} steps, ${r.replaysUsed} of ${r.budget} replays`;
  const stop = r.stopped === "budget" ? "; the budget ran out, so a shorter path may remain untried" : "";
  const refused = r.refused > 0 ? `; ${r.refused} candidate(s) refused by the confirmation guard` : "";
  const draft = r.draftId === undefined ? "; no shorter path achieved the job, so no draft was written" : `; unpromoted draft '${r.draftId}': review it, then jevitate journey promote ${r.draftId}`;
  return `${head}${stop}${refused}${draft}`;
}

/** Registers `jevitate journey shorten <id> --job <jobId> [--budget n] [--out-id <id>]` (#801). */
export function registerJourneyShorten(journey: Command, program: Command, deps: CliDeps): void {
  // Every candidate is a replay of one Journey, as `journey verify` replays one: the same environment,
  // allow, browser, emulation, auth, secret and site-gate wiring, around every candidate.
  withReplayAllowFlag(withEnvironmentFlags(withBrowserLaunchFlags(withEmulationFlags(withFixtureFlags(withProjectFlags(journey.command("shorten <id>")))))))
    .description(
      "authoring time: search for a shorter path to the same job by removing steps (no model); every candidate is a full replay with the fixtures reset around it, decided only by the job's done check in a fresh context; never drops a confirm/agree/accept click. Writes an UNPROMOTED draft and reports the shortest found within budget",
    )
    .requiredOption("--job <jobId>", "the catalog job (.jevitate/jobs.json) whose done check decides every candidate")
    .option("--budget <n>", "replays the search may spend, the recorded path's included (default 30)")
    .option("--out-id <id>", "the draft Journey's id (default <id>-shortest; refused when it exists)")
    .option("--param <kv>", "param as key=value (repeatable)", collectParam, {} as Record<string, string>)
    .option("--secret-field <binding>", REPLAY_SECRET_FIELD_HELP, collectSecretField, [] as string[])
    .option("--storage-state <file>", "Playwright storageState JSON to start each replay (and each done-check reading) authenticated (default: the environment's session)")
    .option("--step-response-timeout <ms>", "#486: how long a step's responseStatus check waits for a matching request that was sent but has no response yet (default 15000; a step's own responseTimeoutMs overrides it; at most 300000), as journey run", intArg({ min: 1, max: MAX_STEP_RESPONSE_TIMEOUT_MS }))
    .option("--json", "emit a JSON envelope")
    .action(async function (this: Command, id: string) {
      const flags = this.opts<
        { project?: string; journeysDir?: string; job: string; budget?: string; outId?: string; param: Record<string, string>; secretField: string[]; storageState?: string; stepResponseTimeout?: number; json?: boolean } & FixtureFlags
      >();
      const layout = journeyLayout(program, deps, { project: flags.project, journeysDir: flags.journeysDir });
      if (layout === null) return;
      const dir = layout.journeysDir;
      const usage = (message: string): void => {
        emitJson(program, fail("E_JOURNEY_SHORTEN_ARGS", message));
        process.exitCode = EXIT_CODES.usage;
      };
      const budget = flags.budget === undefined ? undefined : Number(flags.budget);
      if (budget !== undefined && (!Number.isInteger(budget) || budget < 1 || budget > 500)) return usage("--budget: a whole number of replays from 1 to 500");
      await warnSecretParamsOnArgv(program.configureOutput().writeErr, dir, [id], flags.param, "journey shorten");
      const { env: envName, baseUrl, ...emulationFlags } = this.opts<EnvironmentFlags & EmulationFlags>();
      // #247: where every candidate runs (an unknown env or a bad file is 64, nothing opened).
      let environment: ResolvedJourneyEnvironment | undefined;
      let allow: string[];
      try {
        allow = replayAllowFromFlags(this.opts<{ allow: string[] }>().allow);
        environment = environmentFromFlags({ ...(envName === undefined ? {} : { env: envName }), ...(baseUrl === undefined ? {} : { baseUrl }) }, environmentSeams(deps));
      } catch (err) {
        if (!isEnvironmentError(err)) throw err;
        emitJson(program, fail(err.code, err.message));
        process.exitCode = EXIT_CODES.usage;
        return;
      }
      let browser: ReturnType<typeof browserRunFromFlags>;
      let emulation: ReturnType<typeof emulationFromFlags>;
      try {
        browser = browserRunFromFlags(this.opts<BrowserLaunchFlags & DemoFlags>(), deps.explore?.env ?? process.env);
        emulation = emulationFromFlags(emulationFlags);
      } catch (err) {
        return usage(err instanceof Error ? err.message : String(err));
      }
      // #827: a secret parameter from the environment (--secret-field, the environment's targets.json secretFields), off the command line.
      let params: Record<string, string>;
      let bound: BoundSecretParams | undefined;
      try {
        ({ params, bound } = await withCommandSecretParams({ dir, ids: [id], params: flags.param, flags: flags.secretField, environment, env: deps.explore?.env ?? process.env }));
      } catch (err) {
        const e = secretFieldErrorOf(err, "E_JOURNEY_SHORTEN_ARGS");
        if (e === undefined) throw err;
        emitJson(program, fail(e.code, e.message));
        process.exitCode = EXIT_CODES.usage;
        return;
      }
      // --storage-state wins; else the environment's own session (~/.jevitate/targets.json[<origin>]).
      const storageState = flags.storageState ?? environment?.storageState;
      if (storageState !== undefined && !existsSync(storageState)) return usage(`storage state not found: ${storageState}`);
      const ownFixtureFlags: FixtureFlags = flags;
      // The environment's hooks apply when the flags name none (hooks still need --allow-shell-hooks).
      const fixtureFlags: FixtureFlags = {
        ...ownFixtureFlags,
        ...(ownFixtureFlags.before === undefined && environment?.hooks?.before !== undefined ? { before: environment.hooks.before } : {}),
        ...(ownFixtureFlags.after === undefined && environment?.hooks?.after !== undefined ? { after: environment.hooks.after } : {}),
      };
      const catalogDir = resolveCatalogDir(deps.catalogDir, flaggedCatalogDir(layout));
      try {
        // No --fixtures → the Journey's recorded fixtures: set up before, and restored after, every candidate.
        const recorded = await withRecordedFixtures(fixtureFlags, { dir, id });
        const report = await withSiteGate(resolveDbPath(deps), (siteGate) =>
          shortenJourney({
            dir,
            id,
            jobId: flags.job,
            catalogDir,
            ...(budget === undefined ? {} : { budget }),
            ...(flags.outId === undefined ? {} : { outId: flags.outId }),
            params,
            ...(bound === undefined ? {} : { boundSecretParams: bound }),
            ...(deps.explore?.env === undefined ? {} : { secretEnv: deps.explore.env }),
            ...(siteGate === undefined ? {} : { siteGate }),
            ...(storageState === undefined ? {} : { storageState }),
            ...(browser === undefined ? {} : { browser }),
            ...(emulation === undefined ? {} : { emulation }),
            ...(environment === undefined ? {} : { environment }),
            ...(allow.length === 0 ? {} : { allow }),
            ...(flags.stepResponseTimeout === undefined ? {} : { stepResponseTimeoutMs: flags.stepResponseTimeout }),
            ...(deps.explore?.browserPortFactory === undefined ? {} : { browserPortFactory: deps.explore.browserPortFactory }),
            ...targetsOpts(deps),
            fixtures: (site, allowedOrigins, sourceSite) => {
              // #561: fixture step URLs on a named secondary origin move with the environment's origins.
              const rebaseUrl = fixtureRebaseUrl(environment, sourceSite);
              const fx = buildMissionFixtures(recorded.flags, {
                allowlist: [...allowedOrigins],
                baseUrl: site,
                ...(rebaseUrl === undefined ? {} : { rebaseUrl }),
                ...(storageState === undefined ? {} : { storageState }),
                ...(environment?.fixtures === undefined ? {} : { targetFixtures: environment.fixtures }),
              });
              checkSetupRefs({ "--param": Object.values(flags.param) }, fx);
              return fx;
            },
            onReplay: (replay, steps) => {
              if (flags.json !== true) program.configureOutput().writeErr?.(`replay ${replay}: ${steps} step(s)\n`);
            },
          }),
        );
        if (flags.json === true) emitJson(program, ok(withEngine(report)));
        else program.configureOutput().writeOut?.(`${shortenLine(report)}\n`);
        process.exitCode = report.stopped === "recorded-path-fails" ? EXIT_CODES.inconclusive : EXIT_CODES.ok;
      } catch (err) {
        if (err instanceof JourneyShortenError) {
          emitJson(program, fail(err.code, err.message));
          process.exitCode = err.code === "E_JOURNEY_SHORTEN_ARGS" ? EXIT_CODES.usage : EXIT_CODES.inconclusive;
        } else if (err instanceof ProofHoldRefusedError) {
          // A candidate never holds for a person: the search stops at a step only a person can do, and writes nothing.
          emitJson(program, { ...fail(err.code, err.message), data: { outcome: "inconclusive", kind: err.kind, step: err.step, exitCode: EXIT_CODES.inconclusive } });
          process.exitCode = EXIT_CODES.inconclusive;
        } else if (err instanceof SiteGateRefusedError || isEnvironmentError(err) || err instanceof HttpCheckOffAllowlistError || err instanceof ExtensionMismatchError) {
          emitJson(program, fail(err.code, err.message));
        } else if (err instanceof UnknownJourneyError) {
          emitJson(program, fail("E_UNKNOWN_JOURNEY", err.message));
        } else if (err instanceof JourneyRequiresAuthError) {
          emitJson(program, fail("E_JOURNEY_REQUIRES_AUTH", err.message));
        } else if (err instanceof ParamValidationError) {
          emitJson(program, fail("E_INVALID_PARAMS", err.message));
        } else if (err instanceof FixtureSpecError || err instanceof UnboundSetupRefError) {
          emitJson(program, fail(err.code, err.message));
        } else if (err instanceof FixtureSetupError) {
          // A candidate never runs on unknown state: the search stops, nothing is written.
          emitJson(program, fail("E_JOURNEY_SHORTEN", `fixture setup failed — the search stopped and wrote nothing: ${err.message}`));
          process.exitCode = EXIT_CODES.inconclusive;
        } else throw err;
      }
    });
}
