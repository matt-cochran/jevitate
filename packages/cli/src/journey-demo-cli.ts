import { formatScreenshotsLine, parseScreenshotsArg, type ScreenshotsSpec } from "./run-screenshots.js";
import { existsSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import type { Command } from "commander";
import { ParamValidationError } from "@jevitate/journey";
import { SecretLeakError } from "@jevitate/ai-core";
import { SiteGateRefusedError } from "@jevitate/runtime";
import { type EmulationSpec } from "@jevitate/playwright";
import { ok, fail } from "./envelope.js";
import { UnknownJourneyError, JourneyRequiresAuthError } from "./journey-api.js";
import { DEMO_DEFAULT_PACE_MS, DEMO_MAX_PACE_MS, DemoArgsError, DemoOutputError, demoJourney } from "./journey-demo-api.js";
import { intArg } from "./cli-args.js";
import { artifactStamp } from "./mission-journal.js";
import { logsDirFor } from "./project-dir.js";
import { withSiteGate } from "./site-gate-cli.js";
import { buildMissionFixtures, checkSetupRefs, withFixtureFlags, type FixtureFlags } from "./fixture-cli.js";
import { FixtureSetupError, FixtureSpecError, UnboundSetupRefError } from "./mission-fixtures.js";
import { withEngine } from "./engine.js";
import { EXIT_CODES } from "./exit-codes.js";
import { environmentFromFlags, isEnvironmentError, withEnvironmentFlags, type EnvironmentFlags, type ResolvedJourneyEnvironment } from "./environments.js";
import {
  type CliDeps,
  resolveDbPath,
  resolveJourneysDir,
  type BrowserLaunchFlags,
  withBrowserLaunchFlags,
  browserRunFromFlags,
  withDemoFlags,
  withScreenshotsFlag,
  type ScreenshotsFlags,
  type DemoFlags,
  type EmulationFlags,
  withEmulationFlags,
  emulationFromFlags,
  collectParam,
  emitJson,
  environmentSeams,
} from "./cli-shared.js";

/**
 * #248 — `jevitate journey demo <id>`: replay a Journey as a narrated demo (goal title card, each
 * step's objective as the caption with its target highlighted, an outcome card) and write a video
 * with WebVTT subtitles and/or a Markdown guide with a screenshot per step. Headless by default;
 * `--headed` presents it live. With neither `--video` nor `--guide`, both go to a fresh folder in
 * the logs dir. A Journey that no longer replays writes nothing and exits 1 (a stale demo).
 */
export function registerJourneyDemoCommand(journey: Command, program: Command, deps: CliDeps): void {
  withScreenshotsFlag(withEnvironmentFlags(withDemoFlags(withBrowserLaunchFlags(withEmulationFlags(withFixtureFlags(journey.command("demo <id>")))))))
    .description(
      "replay a Journey as a narrated demo (goal, step objectives as captions, target highlights) → a WebM video with .vtt subtitles " +
        "and/or a Markdown step-by-step guide with screenshots; a Journey that no longer replays fails (exit 1)",
    )
    .option("--dir <path>", "journeys directory (default: the repo's .jevitate/journeys; outside a repo ~/.jevitate/journeys)")
    .option("--param <kv>", "param as key=value (repeatable)", collectParam, {} as Record<string, string>)
    .option("--storage-state <file>", "Playwright storageState JSON to start the replay authenticated; must exist")
    .option("--video <file>", "write the demo video here (.webm) and its subtitles beside it (.vtt)")
    .option("--guide <file>", "write a Markdown guide here (.md), screenshots in <name>.assets/ beside it")
    .option("--pace <ms>", `how long each step's caption shows before it acts (default ${DEMO_DEFAULT_PACE_MS})`, intArg({ min: 0, max: DEMO_MAX_PACE_MS }))
    .option("--action-deltas", "opt-in (#303): record each replayed step's delta, and caption each step with what it changed when its Recording was made (an \"observed:\" line in the subtitles and the guide)")
    .option("--json", "emit a JSON envelope")
    .action(async function (this: Command, id: string) {
      const ownFixtureFlags = this.opts<FixtureFlags>();
      const { dir, param, storageState: storageStateFlag, video: videoFlag, guide: guideFlag, pace, json, env: envName, baseUrl, screenshots: screenshotsFlag, actionDeltas, ...rest } = this.opts<{
        actionDeltas?: boolean;
        dir?: string;
        param: Record<string, string>;
        storageState?: string;
        video?: string;
        guide?: string;
        pace?: number;
        json?: boolean;
      } & EmulationFlags & EnvironmentFlags & ScreenshotsFlags>();
      const out = program.configureOutput().writeOut;
      const journeysDir = resolveJourneysDir(deps, dir);

      // #247: --env/--base-url choose where the demo runs — the same resolver as `journey run`.
      let environment: ResolvedJourneyEnvironment | undefined;
      try {
        environment = environmentFromFlags({ ...(envName === undefined ? {} : { env: envName }), ...(baseUrl === undefined ? {} : { baseUrl }) }, environmentSeams(deps));
      } catch (err) {
        if (!isEnvironmentError(err)) throw err;
        emitJson(program, fail(err.code, err.message));
        return;
      }
      const fixtureFlags: FixtureFlags = {
        ...ownFixtureFlags,
        ...(ownFixtureFlags.before === undefined && environment?.hooks?.before !== undefined ? { before: environment.hooks.before } : {}),
        ...(ownFixtureFlags.after === undefined && environment?.hooks?.after !== undefined ? { after: environment.hooks.after } : {}),
      };
      const storageState = storageStateFlag ?? environment?.storageState;
      if (storageState !== undefined && !existsSync(storageState)) {
        emitJson(program, fail("E_JOURNEY_DEMO_ARGS", `storage state not found: ${storageState}`));
        return;
      }
      // #245: --headed (a display is required) and --slow-mo, resolved before any browser opens.
      let browser: ReturnType<typeof browserRunFromFlags>;
      let emulation: EmulationSpec | undefined;
      let screenshots: ScreenshotsSpec | undefined;
      try {
        browser = browserRunFromFlags(this.opts<BrowserLaunchFlags & DemoFlags>(), deps.explore?.env ?? process.env);
        emulation = emulationFromFlags({ viewport: rest.viewport, device: rest.device });
        screenshots = parseScreenshotsArg(screenshotsFlag);
      } catch (err) {
        emitJson(program, fail("E_JOURNEY_DEMO_ARGS", err instanceof Error ? err.message : String(err)));
        return;
      }
      // Neither output named: both, in a fresh folder in the logs dir (git-ignored, pruned like any run log).
      let video = videoFlag === undefined ? undefined : resolvePath(videoFlag);
      let guide = guideFlag === undefined ? undefined : resolvePath(guideFlag);
      if (video === undefined && guide === undefined) {
        const folder = join(logsDirFor(), `journey-demo-${id.replace(/[^A-Za-z0-9._-]/g, "_")}-${artifactStamp(new Date().toISOString())}`);
        video = join(folder, "demo.webm");
        guide = join(folder, "guide.md");
      }

      try {
        const result = await withSiteGate(resolveDbPath(deps), (siteGate) =>
          demoJourney({
            ...(siteGate === undefined ? {} : { siteGate }),
            dir: journeysDir,
            id,
            params: param,
            browserPortFactory: deps.explore?.browserPortFactory,
            ...(browser === undefined ? {} : { browser }),
            ...(emulation === undefined ? {} : { emulation }),
            ...(screenshots === undefined ? {} : { screenshots }),
            ...(actionDeltas === true ? { actionDeltas: true } : {}),
            ...(storageState !== undefined ? { storageState } : {}),
            ...(environment === undefined ? {} : { environment }),
            ...(video === undefined ? {} : { video }),
            ...(guide === undefined ? {} : { guide }),
            ...(pace === undefined ? {} : { paceMs: pace }),
            fixtures: (site) => {
              const fx = buildMissionFixtures(fixtureFlags, {
                allowlist: environment === undefined ? [site] : environment.allowedOrigins,
                baseUrl: site,
                ...(storageState !== undefined ? { storageState } : {}),
                ...(environment?.fixtures === undefined ? {} : { targetFixtures: environment.fixtures }),
              });
              checkSetupRefs({ "--param": Object.values(param) }, fx);
              return fx;
            },
          }),
        );
        const data = withEngine(result);
        // A stale demo (the Journey no longer replays) is a failed check: exit 1, and nothing written.
        const exit = result.outcome === "ok" ? EXIT_CODES.ok : EXIT_CODES.defects;
        if (json) {
          emitJson(program, ok(data));
        } else if (result.outcome === "stale") {
          program.configureOutput().writeErr?.(
            `error: demo of journey '${id}' is stale: it no longer replays` +
              `${result.stoppedAtStep === undefined ? "" : ` (stopped at step ${result.stoppedAtStep} of ${result.totalSteps})`}: ${result.reason ?? "unknown"}\n` +
              `nothing was written — fix or re-record the Journey, then regenerate the demo\n`,
          );
        } else {
          out?.(`demo of journey '${id}': ${result.steps.length} step(s) replayed\n`);
          if (result.video !== undefined) out?.(`video: ${result.video}\nsubtitles: ${result.subtitles ?? ""}\n`);
          if (result.guide !== undefined) out?.(`guide: ${result.guide}\n`);
          if (result.screenshotIndex !== undefined) out?.(formatScreenshotsLine(result));
        }
        process.exitCode = exit;
      } catch (err) {
        if (err instanceof SiteGateRefusedError || isEnvironmentError(err)) emitJson(program, fail(err.code, err.message));
        else if (err instanceof DemoArgsError || err instanceof DemoOutputError) emitJson(program, fail(err.code, err.message));
        else if (err instanceof UnknownJourneyError) emitJson(program, fail("E_UNKNOWN_JOURNEY", err.message));
        else if (err instanceof JourneyRequiresAuthError) emitJson(program, fail("E_JOURNEY_REQUIRES_AUTH", err.message));
        else if (err instanceof ParamValidationError) emitJson(program, fail("E_INVALID_PARAMS", err.message));
        else if (err instanceof FixtureSpecError || err instanceof UnboundSetupRefError) emitJson(program, fail(err.code, err.message));
        else if (err instanceof FixtureSetupError) emitJson(program, fail("E_JOURNEY_DEMO", err.message));
        else if (err instanceof SecretLeakError) emitJson(program, fail("E_JOURNEY_DEMO_SECRET", err.message));
        else emitJson(program, fail("E_JOURNEY_DEMO", String(err instanceof Error ? err.message : err)));
      }
    });
}
