import { existsSync } from "node:fs";
import { Command } from "commander";
import { ok, fail } from "./envelope.js";
import { JourneyRequiresAuthError } from "./journey-api.js";
import { runJourneyLoadTest, UnknownLoadJourneyError } from "./load-api.js";
import { withSiteGate } from "./site-gate-cli.js";
import { withEngine } from "./engine.js";
import { finiteNumberArg, positiveIntArg } from "./cli-args.js";
import { type EmulationSpec } from "@jevitate/playwright";
import { environmentFromFlags, isEnvironmentError, withEnvironmentFlags, type EnvironmentFlags, type ResolvedJourneyEnvironment } from "./environments.js";
import {
  type CliDeps,
  resolveDbPath,
  resolveJourneysDir,
  type BrowserLaunchFlags,
  withBrowserLaunchFlags,
  browserOption,
  type EmulationFlags,
  withEmulationFlags,
  emulationFromFlags,
  collectParam,
  emitJson,
  environmentSeams,
} from "./cli-shared.js";

/** Registers `jevitate load run`. */
export function registerLoadCommands(program: Command, deps: CliDeps): void {
  const load = program.command("load").description("run a promoted Journey as a load test");

  withEnvironmentFlags(withBrowserLaunchFlags(withEmulationFlags(load.command("run <journeyId>"))))
    .option("--dir <path>", "journeys directory (default: ~/.jevitate/journeys)")
    .option("--param <kv>", "param as key=value (repeatable)", collectParam, {} as Record<string, string>)
    // `--authorized-origin` is mandatory, but enforced IN THE ACTION (below)
    // via a `fail` envelope rather than commander's `.requiredOption` — which
    // hard-exits via `process.exit`, inconsistent with this CLI's convention
    // of emitting a JSON envelope + setting `process.exitCode` (see emitJson).
    .option(
      "--authorized-origin <origin>",
      "allowed load-test target origin (repeatable) — required, fails closed if omitted",
      (v, prev: string[]) => [...prev, v],
      [] as string[],
    )
    .option("--concurrency <n>", "pool size", positiveIntArg, 1)
    .option("--iterations <n>", "iterations per actor", positiveIntArg, 1)
    .option("--seed <n>", "master RNG seed", finiteNumberArg, 1)
    .option(
      "--storage-state <file>",
      "Playwright storageState JSON to start every actor's session authenticated (#118: required when the journey declares metadata.requiresAuth); must exist",
    )
    .option("--json", "emit a JSON envelope")
    .action(async function (this: Command, journeyId: string) {
      const { dir, param, authorizedOrigin, concurrency, iterations, seed, storageState: storageStateFlag, json, env: envName, baseUrl, ...emulationFlags } = this.opts<{
        dir?: string;
        param: Record<string, string>;
        authorizedOrigin: string[];
        concurrency: string;
        iterations: string;
        seed: string;
        storageState?: string;
        json?: boolean;
      } & EmulationFlags & EnvironmentFlags>();
      if (authorizedOrigin.length === 0) {
        emitJson(
          program,
          fail("E_LOAD_RUN", "at least one --authorized-origin is required (refusing to load-test with an empty allowlist)"),
        );
        return;
      }
      // #247: --env/--base-url choose where the load runs (unknown env / bad file → 64, nothing opened).
      let environment: ResolvedJourneyEnvironment | undefined;
      try {
        environment = environmentFromFlags({ ...(envName === undefined ? {} : { env: envName }), ...(baseUrl === undefined ? {} : { baseUrl }) }, environmentSeams(deps));
      } catch (err) {
        if (!isEnvironmentError(err)) throw err;
        emitJson(program, fail(err.code, err.message));
        return;
      }
      const storageState = storageStateFlag ?? environment?.storageState;
      if (storageState !== undefined && !existsSync(storageState)) {
        emitJson(program, fail("E_LOAD_RUN_ARGS", `storage state not found: ${storageState}`));
        return;
      }
      let loadRunEmulation: EmulationSpec | undefined;
      try {
        loadRunEmulation = emulationFromFlags(emulationFlags);
      } catch (err) {
        emitJson(program, fail("E_LOAD_RUN_ARGS", err instanceof Error ? err.message : String(err)));
        return;
      }
      try {
        const report = await withSiteGate(resolveDbPath(deps), (siteGate) => runJourneyLoadTest({
          ...(siteGate === undefined ? {} : { siteGate }),
          dir: resolveJourneysDir(deps, dir),
          id: journeyId,
          params: param,
          concurrency: Number(concurrency),
          iterationsPerActor: Number(iterations),
          seed: Number(seed),
          authorizedOrigins: authorizedOrigin,
          browserPortFactory: deps.explore?.browserPortFactory,
          ...browserOption(this.opts<BrowserLaunchFlags>()),
          ...(loadRunEmulation === undefined ? {} : { emulation: loadRunEmulation }),
          ...(storageState !== undefined ? { storageState } : {}),
          ...(environment === undefined ? {} : { environment }),
        })).then((r) => withEngine(r));
        const envelope = ok(report);
        if (json) {
          emitJson(program, envelope);
        } else {
          program.configureOutput().writeOut?.(`${JSON.stringify(report, null, 2)}\n`);
          process.exitCode = 0;
        }
      } catch (err) {
        if (isEnvironmentError(err)) {
          emitJson(program, fail(err.code, err.message));
        } else if (err instanceof UnknownLoadJourneyError) {
          emitJson(program, fail("E_UNKNOWN_JOURNEY", String(err.message)));
        } else if (err instanceof JourneyRequiresAuthError) {
          emitJson(program, fail("E_JOURNEY_REQUIRES_AUTH", String(err.message)));
        } else {
          emitJson(program, fail("E_LOAD_RUN", String(err instanceof Error ? err.message : err)));
        }
      }
    });
}
