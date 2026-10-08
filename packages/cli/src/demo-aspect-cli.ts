import { JEV_PROVIDER_FLAG_HELP, jevProviderArg } from "./cli-shared.js";
import { TAG_FLAG, TAG_HELP, collectTag, taggedAction } from "./run-tags-cli.js";
import { existsSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import type { Command } from "commander";
import { MissingCredentialError, SecretLeakError } from "@jevitate/ai-core";
import { UnauthorizedExploreTargetError, type SafetyConfig } from "@jevitate/explore";
import { formatAnnotationChanges } from "@jevitate/journey";
import { SiteGateRefusedError } from "@jevitate/runtime";
import type { EmulationSpec } from "@jevitate/playwright";
import { ok, fail } from "./envelope.js";
import { intArg, positiveIntArg } from "./cli-args.js";
import { artifactStamp } from "./mission-journal.js";
import { logsDirFor } from "./project-dir.js";
import { withSiteGate } from "./site-gate-cli.js";
import { buildMissionFixtures, withFixtureFlags, type FixtureFlags } from "./fixture-cli.js";
import { FixtureSetupError, FixtureSpecError, UnboundSetupRefError } from "./mission-fixtures.js";
import { withEngine } from "./engine.js";
import { EXIT_CODES } from "./exit-codes.js";
import { parseAssertionSpec } from "./explore-api.js";
import { isEnvironmentError, resolveJourneyEnvironment, type ResolvedJourneyEnvironment } from "./environments.js";
import { loadTargetsFile, TargetConfigError } from "./target-config.js";
import { UnknownJourneyError, JourneyRequiresAuthError } from "./journey-api.js";
import { AnnotationDraftNotFoundError, InvalidAnnotationDraftError, StaleAnnotationDraftError } from "./journey-annotate-api.js";
import { DEMO_DEFAULT_PACE_MS, DEMO_MAX_PACE_MS, DemoArgsError, DemoOutputError } from "./journey-demo-api.js";
import {
  DemoAspectArgsError,
  DemoDraftNotFoundError,
  DemoExistsError,
  DemoProductionEnvironmentError,
  InvalidDemoDraftError,
  approveDemo,
  assertDemoEnvironment,
  demoAspect,
  demoJourneyId,
  loadDemoForApproval,
  type DemoReplayOptions,
} from "./demo-aspect-api.js";
import {
  type CliDeps,
  resolveDbPath,
  resolveJourneysDir,
  type BrowserLaunchFlags,
  withBrowserLaunchFlags,
  browserRunFromFlags,
  withDemoFlags,
  type DemoFlags,
  type EmulationFlags,
  withEmulationFlags,
  emulationFromFlags,
  emitJson,
  emitUsageLine,
  environmentSeams,
  GatewaySelectionError,
  buildExploreGateways,
} from "./cli-shared.js";
import { clock } from "@jevitate/domain";

/**
 * #249 — `jevitate demo "<aspect>" --env <name> --success <spec>`: explore → clean path → Journey →
 * annotate → a DRAFT narrated demo; `jevitate demo approve <id>`: the one human approval (promotes the
 * Journey, applies the annotations, renders the final demo). See `demo-aspect-api.ts`.
 */

/** A thrown refusal → its envelope (exit 64 for usage/input codes, else 2), or rethrow-worthy null. */
function refusalOf(err: unknown): { code: string; message: string } | null {
  if (
    err instanceof DemoAspectArgsError ||
    err instanceof DemoProductionEnvironmentError ||
    err instanceof DemoExistsError ||
    err instanceof DemoDraftNotFoundError ||
    err instanceof InvalidDemoDraftError ||
    err instanceof DemoArgsError ||
    err instanceof DemoOutputError ||
    err instanceof SiteGateRefusedError ||
    err instanceof AnnotationDraftNotFoundError ||
    err instanceof InvalidAnnotationDraftError ||
    err instanceof StaleAnnotationDraftError ||
    err instanceof FixtureSpecError ||
    err instanceof UnboundSetupRefError ||
    isEnvironmentError(err)
  ) {
    return { code: err.code, message: err.message };
  }
  if (err instanceof UnknownJourneyError) return { code: "E_UNKNOWN_JOURNEY", message: err.message };
  if (err instanceof JourneyRequiresAuthError) return { code: "E_JOURNEY_REQUIRES_AUTH", message: err.message };
  if (err instanceof UnauthorizedExploreTargetError) return { code: "E_UNAUTHORIZED_EXPLORE_TARGET", message: err.message };
  if (err instanceof TargetConfigError) return { code: "E_TARGET_CONFIG", message: err.message };
  if (err instanceof SecretLeakError) return { code: "E_DEMO_SECRET", message: err.message };
  if (err instanceof FixtureSetupError) return { code: "E_DEMO", message: err.message };
  return null;
}

interface ReplayFlags extends BrowserLaunchFlags, DemoFlags, EmulationFlags, FixtureFlags {
  storageState?: string;
  pace?: number;
  out?: string;
  dir?: string;
  json?: boolean;
}

/** The shared replay options from a command's flags (throws a typed refusal on unusable input). */
function replayOptionsFrom(
  cmd: Command,
  deps: CliDeps,
  o: ReplayFlags,
  environment: ResolvedJourneyEnvironment,
): Omit<DemoReplayOptions, "siteGate"> {
  const fixtureFlags: FixtureFlags = {
    fixtures: o.fixtures,
    before: o.before ?? environment.hooks?.before,
    after: o.after ?? environment.hooks?.after,
    allowShellHooks: o.allowShellHooks,
    hookTimeoutMs: o.hookTimeoutMs,
    fixtureIdentity: o.fixtureIdentity,
  };
  const storageState = o.storageState ?? environment.storageState;
  if (storageState !== undefined && !existsSync(storageState)) throw new DemoAspectArgsError(`storage state not found: ${storageState}`);
  let browser: ReturnType<typeof browserRunFromFlags>;
  let emulation: EmulationSpec | undefined;
  try {
    browser = browserRunFromFlags(cmd.opts<BrowserLaunchFlags & DemoFlags>(), deps.explore?.env ?? process.env);
    emulation = emulationFromFlags({ viewport: o.viewport, device: o.device });
  } catch (err) {
    throw new DemoAspectArgsError(err instanceof Error ? err.message : String(err));
  }
  return {
    environment,
    ...(storageState === undefined ? {} : { storageState }),
    ...(deps.explore?.browserPortFactory === undefined ? {} : { browserPortFactory: deps.explore.browserPortFactory }),
    ...(browser === undefined ? {} : { browser }),
    ...(emulation === undefined ? {} : { emulation }),
    ...(o.pace === undefined ? {} : { paceMs: o.pace }),
    fixtures: (site) =>
      buildMissionFixtures(fixtureFlags, {
        allowlist: environment.allowedOrigins,
        baseUrl: site,
        ...(storageState === undefined ? {} : { storageState }),
        ...(environment.fixtures === undefined ? {} : { targetFixtures: environment.fixtures }),
      }),
  };
}

function withReplayFlags(cmd: Command): Command {
  return withDemoFlags(withBrowserLaunchFlags(withEmulationFlags(withFixtureFlags(cmd))))
    .option("--dir <path>", "journeys directory (default: the repo's .jevitate/journeys; outside a repo ~/.jevitate/journeys)")
    .option("--storage-state <file>", "Playwright storageState JSON to start authenticated (default: the environment's session in ~/.jevitate/targets.json); must exist")
    .option("--out <dir>", "write the demo (demo.webm + demo.vtt + guide.md with guide.assets/) into this folder (default: a fresh folder in the logs dir)")
    .option("--pace <ms>", `how long each step's caption shows before it acts (default ${DEMO_DEFAULT_PACE_MS})`, intArg({ min: 0, max: DEMO_MAX_PACE_MS }))
    .option("--json", "emit a JSON envelope");
}

function outDirFor(flag: string | undefined, id: string, kind: "draft" | "final"): string {
  if (flag !== undefined) return resolvePath(flag);
  return join(logsDirFor(), `demo-${id}-${kind}-${artifactStamp(clock.nowIso())}`);
}

function stepLines(steps: ReadonlyArray<{ number: number; step: string; objective?: string; expectedResult?: string }>): string {
  return steps
    .map((s) => `  ${s.number}. ${s.objective ?? s.step}${s.expectedResult === undefined ? "" : `\n     expected: ${s.expectedResult}`}\n`)
    .join("");
}

export function registerDemoCommands(program: Command, deps: CliDeps): void {
  const demo = program
    .command("demo")
    .description(
      'demo one aspect of an app from a one-line request: explore → clean path → Journey → annotate → a DRAFT narrated demo; `demo approve <id>` promotes and renders the final one',
    );

  withReplayFlags(demo.command("create <aspect>", { isDefault: true }))
    .description(
      'explore a named non-production environment toward <aspect> (checked by --success), minimize the path to its essential steps (verified by replay), ' +
        "annotate it and render a DRAFT demo (video, .vtt, guide); nothing is promoted until `demo approve <id>` (also: jevitate demo \"<aspect>\")",
    )
    .option("--env <name>", "the named environment to demo on (.jevitate/environments.json); required, and never one flagged production: true")
    .option("--success <spec>", "independent success check that proves the aspect was shown, e.g. textIncludes:testId=status|Saved (required)")
    .option("--persona <name>", "the persona whose session (~/.jevitate/targets.json personas) the demo runs as")
    .option("--id <id>", "the Journey id (default: demo-<aspect slug>)")
    .option("--start <path>", "the app path exploration starts from (default /)")
    .option("--max-actions <n>", "hard cap on explored actions", positiveIntArg)
    .option("--max-decisions <n>", "hard cap on model decisions", positiveIntArg)
    .option("--real", "use live Jev + OpenRouter gateways (requires keys)", false)
    .option("--fake-ai", "use deterministic fake gateways (pipeline smoke only)", false)
    .option("--jev-provider <provider>", JEV_PROVIDER_FLAG_HELP, jevProviderArg)
    .option(TAG_FLAG, TAG_HELP, collectTag, [])
    .action(taggedAction(program, "demo", async function (this: Command, aspect: string) {
      const o = this.opts<
        ReplayFlags & { env?: string; success?: string; persona?: string; id?: string; start?: string; maxActions?: number; maxDecisions?: number; real?: boolean; fakeAi?: boolean; jevProvider?: string }
      >();
      const out = program.configureOutput().writeOut;
      try {
        if (o.success === undefined) throw new DemoAspectArgsError("--success <spec> is required: the independent check that proves the aspect was shown");
        let successAssertion;
        try {
          successAssertion = parseAssertionSpec(o.success);
        } catch (err) {
          throw new DemoAspectArgsError(`--success: ${err instanceof Error ? err.message : String(err)}`);
        }
        const seams = environmentSeams(deps);
        const environment = o.env === undefined ? undefined : resolveJourneyEnvironment({ env: o.env, ...(o.persona === undefined ? {} : { persona: o.persona }), ...seams });
        assertDemoEnvironment(environment); // #249: a named, non-production environment — before anything runs
        const replay = replayOptionsFrom(this, deps, o, environment);
        const safety: SafetyConfig | undefined = (seams.targetsFile === undefined ? loadTargetsFile() : loadTargetsFile(seams.targetsFile))[environment.baseUrl]?.safety;
        const id = o.id ?? demoJourneyId(aspect);
        const { judge, gen, usage } = await buildExploreGateways(deps, { real: o.real ?? false, fakeAi: o.fakeAi ?? false, jevProvider: o.jevProvider });
        const bounds = { ...(o.maxActions === undefined ? {} : { maxActions: o.maxActions }), ...(o.maxDecisions === undefined ? {} : { maxDecisions: o.maxDecisions }) };

        const result = await withSiteGate(resolveDbPath(deps), (siteGate) =>
          demoAspect({
            ...replay,
            ...(siteGate === undefined ? {} : { siteGate }),
            aspect,
            successAssertion,
            successSpec: o.success ?? "",
            journeysDir: resolveJourneysDir(deps, o.dir),
            id,
            ...(o.start === undefined ? {} : { start: o.start }),
            ...(o.persona === undefined ? {} : { persona: o.persona }),
            judge,
            gen,
            ...(Object.keys(bounds).length === 0 ? {} : { bounds }),
            ...(safety === undefined ? {} : { safety }),
            outDir: outDirFor(o.out, id, "draft"),
          }),
        );
        const data = withEngine({ ...result, usage: usage.snapshot() });
        // Only a drafted demo did the job; a goal not reached / a path that does not replay is a failed check.
        process.exitCode = result.outcome === "drafted" ? EXIT_CODES.ok : EXIT_CODES.defects;
        if (o.json) {
          emitJson(program, ok(data));
          return;
        }
        if (result.outcome !== "drafted") {
          program.configureOutput().writeErr?.(`error: demo of "${result.aspect}" on ${result.environment}: ${result.outcome}: ${result.reason ?? "unknown"}\n`);
          emitUsageLine(program, data);
          return;
        }
        const m = result.minimize;
        out?.(`DRAFT demo of "${result.aspect}" on ${result.environment} — journey '${result.id}' (not promoted)\n`);
        if (m !== undefined) {
          out?.(`clean path: explored ${m.exploredSteps} step(s), kept ${m.keptSteps}${m.dropped.length === 0 ? "" : `; dropped: ${m.dropped.join("; ")}`}` +
            `${m.budgetExhausted ? " (replay budget reached: verified, maybe not minimal)" : ""}\n`);
        }
        out?.(`steps (with the drafted annotations):\n${stepLines(result.steps ?? [])}`);
        if (result.annotations !== undefined) out?.(formatAnnotationChanges(result.annotations.proposed));
        if (result.draft?.video !== undefined) out?.(`DRAFT video: ${result.draft.video}\nDRAFT subtitles: ${result.draft.subtitles ?? ""}\n`);
        if (result.draft?.guide !== undefined) out?.(`DRAFT guide: ${result.draft.guide}\n`);
        out?.(`annotations: ${result.annotations?.draftPath ?? ""}\nreview it, then approve (promotes the Journey, renders the final demo): ${result.next ?? ""}\n`);
        emitUsageLine(program, data);
      } catch (err) {
        if (err instanceof MissingCredentialError || err instanceof GatewaySelectionError) {
          emitJson(program, fail("E_AI_SETUP_REQUIRED", err.message));
          return;
        }
        const r = refusalOf(err);
        emitJson(program, r === null ? fail("E_DEMO", String(err instanceof Error ? err.message : err)) : fail(r.code, r.message));
      }
    }));

  withReplayFlags(demo.command("approve <id>"))
    .description(
      "the one human approval of a DRAFT demo: shows the Journey and its annotations, renders the final demo (no DRAFT marks) on the environment it was made on, " +
        "then applies the annotations and promotes the Journey; a replay that no longer works promotes nothing (exit 1)",
    )
    .action(async function (this: Command, id: string) {
      const o = this.opts<ReplayFlags>();
      const out = program.configureOutput().writeOut;
      try {
        const journeysDir = resolveJourneysDir(deps, o.dir);
        const { record } = await loadDemoForApproval(journeysDir, id);
        const environment = resolveJourneyEnvironment({ env: record.env, ...(record.persona === undefined ? {} : { persona: record.persona }), ...environmentSeams(deps) });
        assertDemoEnvironment(environment); // re-checked: the environment may have been flagged production since
        const replay = replayOptionsFrom(this, deps, o, environment);
        const result = await withSiteGate(resolveDbPath(deps), (siteGate) =>
          approveDemo({ ...replay, ...(siteGate === undefined ? {} : { siteGate }), journeysDir, id, outDir: outDirFor(o.out, id, "final") }),
        );
        process.exitCode = result.outcome === "approved" ? EXIT_CODES.ok : EXIT_CODES.defects;
        if (o.json) {
          emitJson(program, ok(withEngine(result)));
          return;
        }
        out?.(`journey '${id}' — "${record.aspect}" on ${result.environment}:\n${stepLines(result.steps)}`);
        if (result.outcome !== "approved") {
          program.configureOutput().writeErr?.(`error: demo '${id}' is stale: ${result.reason ?? "unknown"}\n`);
          return;
        }
        out?.(formatAnnotationChanges(result.changes));
        out?.(`approved: journey '${id}' promoted\n`);
        if (result.final?.video !== undefined) out?.(`video: ${result.final.video}\nsubtitles: ${result.final.subtitles ?? ""}\n`);
        if (result.final?.guide !== undefined) out?.(`guide: ${result.final.guide}\n`);
      } catch (err) {
        const r = refusalOf(err);
        emitJson(program, r === null ? fail("E_DEMO", String(err instanceof Error ? err.message : err)) : fail(r.code, r.message));
      }
    });
}
