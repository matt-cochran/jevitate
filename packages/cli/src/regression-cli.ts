import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Command } from "commander";
import { RecordingSchema } from "@jevitate/recording";
import { BrowseTheWebToken } from "@jevitate/screenplay";
import { ok, fail } from "./envelope.js";
import { runRegressionCapture, runRegressionRun, RegressionNotFoundError, RegressionHardSignalOracleError, RegressionExistsError } from "./regression-api.js";
import { regressionFixtures, withFixtureFlags, type FixtureFlags } from "./fixture-cli.js";
import { rebindReplayNavigation, type MissionFixtures } from "./mission-fixtures.js";
import { withEngine } from "./engine.js";
import { positiveIntArg } from "./cli-args.js";
import { formatRegressionCaptureHuman, formatRegressionRunHuman } from "./cli-output.js";
import { type EmulationSpec } from "@jevitate/playwright";
import { environmentFromFlags, isEnvironmentError, withEnvironmentFlags, type EnvironmentFlags, type ResolvedJourneyEnvironment } from "./environments.js";
import {
  type CliDeps,
  resolveRegressionsDir,
  makeRealBrowserActor,
  type BrowserLaunchFlags,
  withBrowserLaunchFlags,
  browserRunFromFlags,
  withDemoFlags,
  type DemoFlags,
  type EmulationFlags,
  withEmulationFlags,
  emulationFromFlags,
  emitJson,
  environmentSeams,
  refuseUnsafeName,
  writeHumanResult,
} from "./cli-shared.js";

/** Registers `jevitate regression`: `capture` and `run`. */
export function registerRegressionCommands(program: Command, deps: CliDeps): void {
  // Additive: `@jevitate/regression` — reproduce -> minimize -> commit a
  // failing Recording into a committed regression artifact (Ticket #5).
  // Independent of the `journey`/`load` commands above; wires a real
  // Playwright-backed `makeActor` (one fresh browser session per
  // reproduce/minimize attempt, closed after each use) into
  // `runRegressionCapture`.
  const regression = program.command("regression").description("capture, run and manage regression tests from discovered failures");

  withDemoFlags(withBrowserLaunchFlags(withEmulationFlags(withFixtureFlags(regression.command("capture")))))
    .requiredOption("--from <file>", "path to the schema-valid failing Recording JSON to capture")
    .requiredOption("--id <id>", "regression id (used for the committed <id>.recording.json/<id>.meta.json filenames)")
    .option("--dir <path>", "regressions directory (default: the repo's .jevitate/regressions; outside a repo ~/.jevitate/regressions)")
    .option("--attempts <n>", "reproduction attempts before labeling flaky", positiveIntArg, 3)
    .option("--summary <text>", "optional human-readable bug summary recorded in the meta sidecar")
    .option(
      "--result <file>",
      "mission result JSON (as written alongside --from by `jevitate explore`) — supplies a failure oracle when the Recording alone never fails on replay",
    )
    .option(
      "--fingerprint <fp>",
      "pin the required failure — a structural step signature (alone, restricts --from to failing at exactly that step), or (with --result, #119/#129) a defect/invariant fingerprint from the mission's own findings; with --result alone, cross-checks the derived oracle",
    )
    .option(
      "--storage-state <file>",
      "Playwright storageState JSON to open the reproduce/minimize browser sessions authenticated (#129); must exist",
    )
    .option("--force", "overwrite an existing regression id's committed files (default: refused, #213)", false)
    .option("--json", "emit a JSON envelope")
    .action(async function (this: Command) {
      // #245: demo mode (--headed/--slow-mo), resolved before any browser opens.
      let browser: ReturnType<typeof browserRunFromFlags>;
      try {
        browser = browserRunFromFlags(this.opts<BrowserLaunchFlags & DemoFlags>(), deps.explore?.env ?? process.env);
      } catch (err) {
        emitJson(program, fail("E_REGRESSION_ARGS", err instanceof Error ? err.message : String(err)));
        return;
      }
      const flags = this.opts<{
        from: string;
        id: string;
        dir?: string;
        attempts: string;
        summary?: string;
        result?: string;
        fingerprint?: string;
        storageState?: string;
        force?: boolean;
        json?: boolean;
      } & FixtureFlags & EmulationFlags>();
      const { from, id, dir, attempts, summary, result: resultPath, fingerprint, storageState, force, json } = flags;
      if (refuseUnsafeName(program, id, "regression id")) return;
      // #218: unusable input is refused up front (64), never a capture that broke at runtime (2).
      for (const [flag, path] of [["--from", from], ["--result", resultPath]] as const) {
        if (path !== undefined && !existsSync(path)) {
          emitJson(program, fail("E_REGRESSION_ARGS", `${flag} file not found: ${path}`));
          return;
        }
      }
      if (storageState !== undefined && !existsSync(storageState)) {
        emitJson(program, fail("E_REGRESSION_ARGS", `storage state not found: ${storageState}`));
        return;
      }
      let captureEmulationFlag: EmulationSpec | undefined;
      try {
        captureEmulationFlag = emulationFromFlags(flags);
      } catch (err) {
        emitJson(program, fail("E_REGRESSION_ARGS", err instanceof Error ? err.message : String(err)));
        return;
      }
      const opened: Array<() => Promise<void>> = [];
      let fx: MissionFixtures | undefined;
      try {
        const raw = JSON.parse(await readFile(from, "utf8"));
        const recording = RecordingSchema.parse(raw);
        // #149: --viewport/--device, else the Recording's OWN emulation (reproduces under the same device).
        const captureEmulation: EmulationSpec | undefined =
          captureEmulationFlag ??
          (recording.emulation === undefined
            ? undefined
            : recording.emulation.device !== undefined
              ? { device: recording.emulation.device }
              : { viewport: recording.emulation.viewport });
        // #144: every reproduce/minimize replay restores the fixture state the Recording started from.
        fx = regressionFixtures(
          flags,
          recording,
          resultPath === undefined ? undefined : JSON.parse(await readFile(resultPath, "utf8")),
          storageState,
        );
        const replayFixture = fx;

        const result = await runRegressionCapture({
          failingRecordingPath: from,
          id,
          regressionsDir: resolveRegressionsDir(dir),
          attempts: Number(attempts),
          bugSummary: summary,
          resultPath,
          fingerprint,
          force,
          makeActor: async () => {
            await replayFixture?.reset();
            const { actor, close } = await makeRealBrowserActor(recording.site, storageState, captureEmulation, browser, deps.explore?.browserPortFactory);
            opened.push(close);
            if (replayFixture !== undefined) {
              rebindReplayNavigation(actor.ability(BrowseTheWebToken).session.page, recording.fixture?.outputs ?? {}, replayFixture.publicOutputs());
            }
            return actor;
          },
        }).then((r) => withEngine(r));
        await fx?.restore();
        const envelope = ok(fx === undefined ? result : { ...result, fixtures: fx.record() });
        if (json) {
          emitJson(program, envelope);
        } else {
          // #227/#230: a human summary (captured/flaky, where the files went, what to run next,
          // carrying the same --dir the user passed) — never the raw result JSON, which used to
          // print unconditionally without --json.
          writeHumanResult(program, result, (r) => formatRegressionCaptureHuman(r, { dir }));
          process.exitCode = 0;
        }
      } catch (err) {
        // #213: these two are usage refusals (64) — an existing id needing --force, or a
        // hard-signal defect that needs `ledger add` instead — never a generic capture failure (2).
        if (err instanceof RegressionExistsError || err instanceof RegressionHardSignalOracleError) {
          emitJson(program, fail(err.code, err.message));
        } else {
          emitJson(program, fail("E_REGRESSION_CAPTURE", String(err instanceof Error ? err.message : err)));
        }
      } finally {
        for (const close of opened) await close();
        await fx?.restore();
      }
    });

  // Additive: `regression run <id>` (#129 item 4) — replays a committed regression (whatever
  // `regression capture` wrote — a step-oracle, network-check, or declared-invariant one) and
  // reports "reproduces" or "fixed". The one CLI/MCP surface `loadRegressions`/`replayRegression`
  // (`@jevitate/regression`) previously had none of.
  withEnvironmentFlags(withDemoFlags(withBrowserLaunchFlags(withEmulationFlags(regression.command("run")))))
    .argument("<id>", "the committed regression id (its <id>.recording.json/<id>.meta.json)")
    .option("--dir <path>", "regressions directory (default: the repo's .jevitate/regressions; outside a repo ~/.jevitate/regressions)")
    .option("--attempts <n>", "fresh-context replays for a declared-invariant oracle (default 3)", positiveIntArg)
    .option("--storage-state <file>", "Playwright storageState JSON to open the replay session authenticated (#129); must exist")
    .option("--json", "emit a JSON envelope")
    .action(async function (this: Command, id: string) {
      // #245: demo mode (--headed/--slow-mo), resolved before any browser opens.
      let browser: ReturnType<typeof browserRunFromFlags>;
      try {
        browser = browserRunFromFlags(this.opts<BrowserLaunchFlags & DemoFlags>(), deps.explore?.env ?? process.env);
      } catch (err) {
        emitJson(program, fail("E_REGRESSION_ARGS", err instanceof Error ? err.message : String(err)));
        return;
      }
      const { dir, attempts, storageState: storageStateFlag, json, env: envName, baseUrl, ...emulationFlags } = this.opts<
        { dir?: string; attempts?: string; storageState?: string; json?: boolean } & EmulationFlags & EnvironmentFlags
      >();
      // #247: --env/--base-url choose where the regression replays (unknown env / bad file → 64).
      let environment: ResolvedJourneyEnvironment | undefined;
      try {
        environment = environmentFromFlags({ ...(envName === undefined ? {} : { env: envName }), ...(baseUrl === undefined ? {} : { baseUrl }) }, environmentSeams(deps));
      } catch (err) {
        if (!isEnvironmentError(err)) throw err;
        emitJson(program, fail(err.code, err.message));
        return;
      }
      // --storage-state wins; else the environment's own session (~/.jevitate/targets.json[<origin>]).
      const storageState = storageStateFlag ?? environment?.storageState;
      if (storageState !== undefined && !existsSync(storageState)) {
        emitJson(program, fail("E_REGRESSION_ARGS", `storage state not found: ${storageState}`));
        return;
      }
      let runEmulationFlag: EmulationSpec | undefined;
      try {
        runEmulationFlag = emulationFromFlags(emulationFlags);
      } catch (err) {
        emitJson(program, fail("E_REGRESSION_ARGS", err instanceof Error ? err.message : String(err)));
        return;
      }
      if (refuseUnsafeName(program, id, "regression id")) return;
      const regressionsDir = resolveRegressionsDir(dir);
      // #218: an unknown id is a usage error (64), refused before anything opens.
      if (!existsSync(join(regressionsDir, `${id}.recording.json`))) {
        const notFound = new RegressionNotFoundError(id, regressionsDir);
        emitJson(program, fail(notFound.code, notFound.message));
        return;
      }
      const opened: Array<() => Promise<void>> = [];
      try {
        const recording = RecordingSchema.parse(JSON.parse(await readFile(join(regressionsDir, `${id}.recording.json`), "utf8")));
        // #149: --viewport/--device, else the committed Recording's OWN emulation.
        const runEmulation: EmulationSpec | undefined =
          runEmulationFlag ??
          (recording.emulation === undefined
            ? undefined
            : recording.emulation.device !== undefined
              ? { device: recording.emulation.device }
              : { viewport: recording.emulation.viewport });
        const report = await runRegressionRun({
          id,
          regressionsDir,
          ...(attempts !== undefined ? { attempts: Number(attempts) } : {}),
          ...(environment === undefined ? {} : { environment }),
          makeActor: async () => {
            const { actor, close } = await makeRealBrowserActor(
              environment?.baseUrl ?? recording.site,
              storageState,
              runEmulation,
              browser,
              deps.explore?.browserPortFactory,
              environment?.allowedOrigins,
            );
            opened.push(close);
            return actor;
          },
        });
        const envelope = ok(withEngine(report));
        if (json) {
          emitJson(program, envelope);
        } else {
          // #227/#230: the verdict/reason/next-step summary (carrying the same --dir the user
          // passed) — never the raw report JSON.
          program.configureOutput().writeOut?.(formatRegressionRunHuman(report, { dir }));
        }
        process.exitCode = report.verdict === "reproduces" ? 1 : report.verdict === "fixed" ? 0 : 2;
      } catch (err) {
        if (err instanceof RegressionNotFoundError || isEnvironmentError(err)) {
          emitJson(program, fail(err.code, err.message));
        } else {
          emitJson(program, fail("E_REGRESSION_RUN", String(err instanceof Error ? err.message : err)));
        }
      } finally {
        for (const close of opened) await close();
      }
    });
}
