import { JEV_PROVIDER_FLAG_HELP, jevProviderArg } from "./cli-shared.js";
import { assertHttpChecksAllowed, HttpCheckOffAllowlistError } from "./http-probe.js";
import { FixturePathError } from "@jevitate/recording";
import { existsSync } from "node:fs";
import { Command } from "commander";
import { MissingCredentialError, UsageTracker, type JudgmentPort, type GenerationPort } from "@jevitate/ai-core";
import { FixtureNotFoundError, UnauthorizedExploreTargetError, type AuthorJourneyResult, type AuthorTakeDiagnostics, type SuccessCheck } from "@jevitate/explore";
import { ok, fail } from "./envelope.js";
import { positiveIntArg } from "./cli-args.js";
import { runAuthorJourney, parseSuccessSpec, resolveExploreAllowlist } from "./explore-api.js";
import { allowWithExtensions } from "./browser-run-options.js";
import { FixtureSpecError, UnboundSetupRefError, type MissionFixtures } from "./mission-fixtures.js";
import { buildMissionFixtures, checkSetupRefs, checkUrlRefOrigin, setupRefFreeUrl, withFixtureFlags, type FixtureFlags } from "./fixture-cli.js";
import {
  type CliDeps,
  type BrowserLaunchFlags,
  withBrowserLaunchFlags,
  browserLaunchFromFlags,
  emitJson,
  writeHumanResult,
  GatewaySelectionError,
  buildExploreGateways,
  withEmulationFlags,
  withScreenshotsFlag,
} from "./cli-shared.js";
import { journeyLinkWarnings } from "./journey-link-hints.js";
import { journeyLayout, lintFindingLine } from "./journey-cli/shared.js";
import { withProjectFlags } from "./project-layout.js";
import type { JourneyLintFinding } from "@jevitate/journey";
import { GOAL_RUN_OPTIONS, GoalRunFlagError, resolveGoalRunFlags, type GoalRunFlags, type GoalRunShaping } from "./goal-run-flags.js";
import { triagedServerLog, type ServerLogOptions } from "./explore-shared.js";
import { withServerLogFlags } from "./server-log-flags.js";
import { serverLogOptionsFromFlags, type ServerLogFlags } from "./explore-cli/shared.js";
import { LogSourceSpecError } from "./log-sources.js";
import { LogSpecError } from "./log-lines.js";
import { LogClassesError } from "./log-classes.js";

/**
 * #369: the goal-run flags `explore-author-journey` shares with `explore` — every take is that goal
 * run, so it can reproduce whatever setup the goal run needed (in `explore`'s own order).
 */
const AUTHOR_GOAL_RUN_FLAGS = [
  "successWhen", "allowVacuousChecks", "actionDeltas", "secret", "secretField", "totp", "typeFixture", "fixture",
  "saveStorageState", "replyWaitMs", "replyQuietMs", "replyCeilingMs", "replyMaxChars", "jobWaitMs", "deny", "paid", "allowControl",
  "allowDestructive", "allowWrites", "dialogs", "readRpc", "hangReplays", "settleIgnore", "longPollMs", "apiPrefix", "ignoreNoProgress",
  "allowSecretCmd", "secretCmdAttempts",
] as const satisfies readonly (keyof typeof GOAL_RUN_OPTIONS)[];

/** #369: one take's diagnostics as human lines (the paths a person opens next). */
function takeLines(label: string, d: AuthorTakeDiagnostics): string[] {
  const lines = [`  ${label}: ${d.outcome}${d.stop === undefined ? "" : ` (stop: ${d.stop})`}${d.actions === undefined ? "" : ` · ${d.actions} action(s), ${d.decisions ?? 0} decision(s)`}`];
  if (d.reason !== undefined) lines.push(`    reason: ${d.reason}`);
  for (const c of d.checks ?? []) lines.push(`    check ${c.passed ? "held" : "FAILED"}: ${c.check}${c.passed ? "" : ` — ${c.detail}`}`);
  if (d.resultPath !== undefined) lines.push(`    result: ${d.resultPath}`);
  if (d.transcriptPath !== undefined) lines.push(`    transcript: ${d.transcriptPath}`);
  for (const r of d.recordingPaths ?? []) lines.push(`    recording: ${r}`);
  if (d.screenshotsDir !== undefined) lines.push(`    screenshots: ${d.screenshotsDir}`);
  return lines;
}

/** #369: the human summary of `explore-author-journey` (the JSON is the same data with `--json`). */
/**
 * #523: an authored Journey's catalog link warnings (no job / no persona link, each with its fix) —
 * advisory: they never change the outcome or the exit code.
 */
export async function withLinkWarnings<R extends AuthorJourneyResult>(result: R, catalogDir: string | null): Promise<R & { linkWarnings?: JourneyLintFinding[] }> {
  if (result.outcome !== "authored") return result;
  const linkWarnings = await journeyLinkWarnings(catalogDir, result.journey);
  return linkWarnings.length === 0 ? result : { ...result, linkWarnings };
}

export function formatAuthorJourneyHuman(data: unknown): string {
  const r = data as AuthorJourneyResult & { linkWarnings?: JourneyLintFinding[] };
  const lines: string[] = [];
  if (r.outcome === "authored") {
    const m = r.journey.metadata;
    lines.push(`AUTHORED: journey ${m.id} (unpromoted; \`jevitate journey promote ${m.id}\` makes it runnable)`);
    if (m.params.length > 0) lines.push(`  params: ${m.params.join(", ")}`);
  } else {
    lines.push(`NOT REACHED: ${r.reason}`);
  }
  if (r.takes !== undefined) lines.push(`  takes: ${r.takes.succeeded}/${r.takes.run} reached the goal (${r.takes.requested} requested)`);
  if (r.discovery !== undefined) lines.push(...takeLines("discovery", r.discovery));
  if (r.outcome === "authored") (r.corroboratingTakes ?? []).forEach((d, i) => lines.push(...takeLines(`take ${i + 2}`, d)));
  for (const w of r.linkWarnings ?? []) lines.push(`  ${lintFindingLine(w)}`);
  return `${lines.join("\n")}\n`;
}

/** Registers `jevitate explore-author-journey` (Jev authors an unpromoted, parameterized Journey). */
export function registerAuthorJourneyCommands(program: Command, deps: CliDeps): void {
  // Additive: `explore author-journey` — Jev-driving authors a promotable
  // Journey (Ticket #6). Drives the goal-based mission, feeds its take(s)
  // through RxD's diff/postdoc pipeline, and writes an UNPROMOTED,
  // parameterized Journey to the journeys store. The record-by-demonstration
  // authoring path is untouched.
  const cmd = withServerLogFlags(
    withBrowserLaunchFlags(
      withProjectFlags(
        program
          .command("explore-author-journey")
          .description("Jev-driving authors a promotable Journey (authoring plane); never auto-promoted"),
      ),
    ),
  )
    .option("--url <url>", "target URL (must be an authorized origin)")
    .option("--goal <text>", "natural-language goal")
    .option(
      "--success <spec>",
      "independent success check (repeatable; all must hold), any explore --success kind, e.g. urlIncludes:/confirmed, " +
        "'reloadThen:textIncludes:css=main|Saved', 'responseStatus:POST /api/save=2xx' or 'http:GET <outbox url>|jsonPath=$.messages[*].Subject|includes=Reset' (its origin must be in --allow): every check is kept as the Journey's end state and re-checked after every replay's last step",
      (v, prev: string[]) => [...prev, v],
      [] as string[],
    )
    .option("--id <id>", "journey id (used for the <id>.json filename in the store)")
    .option("--name <name>", "human-readable journey name")
    .option("--takes <n>", "corroborating takes incl. discovery (default 1)", positiveIntArg, 1)
    .option(
      "--storage-state <file>",
      "Playwright storageState JSON to start the session authenticated (deterministic login pre-step); must exist",
    )
    .option(
      "--allow <origin>",
      "authorized origin (repeatable); REPLACES the default allowlist when given (the URL's own origin is used only when --allow is omitted entirely) -- include the URL's own origin explicitly if you still need it",
      (v, prev: string[]) => [...prev, v],
      [] as string[],
    )
    .option("--max-actions <n>", "hard cap on executed actions", positiveIntArg)
    .option("--max-decisions <n>", "hard cap on model decisions", positiveIntArg)
    .option("--out <dir>", "directory each take's result, transcript and Recording are written to (default: .jevitate/logs/<date>)")
    .option("--real", "use live Jev + OpenRouter gateways (requires keys)", false)
    .option("--fake-ai", "use deterministic fake gateways (pipeline smoke only)", false)
    .option("--jev-provider <provider>", JEV_PROVIDER_FLAG_HELP, jevProviderArg)
    .option("--json", "emit a JSON envelope");
  // #369: every take is `explore`'s goal run, so author takes its run-shaping flags too.
  for (const name of AUTHOR_GOAL_RUN_FLAGS) cmd.addOption(GOAL_RUN_OPTIONS[name]());
  // #544: the same mission fixtures `explore` takes: set up before, and restored after, every take.
  withFixtureFlags(withScreenshotsFlag(withEmulationFlags(cmd)))
    .addHelpText(
      "after",
      [
        "",
        "Each take is a full goal run (the same runner and run-shaping flags as `jevitate explore --strategy goal`),",
        "writing its own result, transcript and Recording (under --out). A take that does not reach the goal",
        "is reported with its stop reason, its checks' verdicts and those paths. A field code types itself",
        "(--secret-field/--totp) becomes a secret Journey parameter (secret1, …), passed with --param at replay.",
        "Every --success check is kept as the Journey's end state (metadata.endState); each step's expect comes from what it",
        "changed (a write's responseStatus, text it added — richer with --action-deltas), never from its own target.",
      ].join("\n"),
    )
    .action(async function (this: Command) {
      const o = this.opts<{
        url?: string;
        goal?: string;
        success: string[];
        id?: string;
        name?: string;
        takes: string;
        project?: string;
        journeysDir?: string;
        allow: string[];
        maxActions?: string;
        maxDecisions?: string;
        real?: boolean;
        fakeAi?: boolean;
        jevProvider?: string;
        json?: boolean;
        storageState?: string;
        out?: string;
      } & BrowserLaunchFlags & GoalRunFlags & FixtureFlags & ServerLogFlags>();
      if (o.storageState !== undefined && !existsSync(o.storageState)) {
        emitJson(program, fail("E_EXPLORE_ARGS", `storage state not found: ${o.storageState}`));
        return;
      }

      if (!o.url || !o.goal || o.success.length === 0 || !o.id || !o.name) {
        emitJson(program, fail("E_AUTHOR_ARGS", "--url, --goal, --success, --id and --name are all required"));
        return;
      }
      // #322/#400: every kind `explore --success` takes — page, reloadThen and network checks.
      const successChecks: SuccessCheck[] = [];
      try {
        for (const spec of o.success) successChecks.push(parseSuccessSpec(spec));
      } catch (err) {
        emitJson(program, fail("E_EXPLORE_ASSERTION", String(err instanceof Error ? err.message : err)));
        return;
      }
      // #369: the goal run's flags, validated (and secrets resolved) before any gateway or browser.
      let goalRun: GoalRunShaping;
      try {
        goalRun = resolveGoalRunFlags(o, o.url, {
          targetsConfigPath: deps.explore?.targetsConfigPath,
          warn: (text) => program.configureOutput().writeErr?.(text),
        });
      } catch (err) {
        if (!(err instanceof GoalRunFlagError)) throw err;
        emitJson(program, fail(err.code, err.message));
        return;
      }
      // #142/#544: the backend-log flags are validated (spec shape, --allow-log-cmd gate, matcher
      // regexes, --log-triage's source requirement) before any browser or gateway opens.
      let serverLog: ServerLogOptions | undefined;
      try {
        serverLog = serverLogOptionsFromFlags(o);
      } catch (err) {
        if (err instanceof LogSourceSpecError || err instanceof LogSpecError || err instanceof LogClassesError || err instanceof GoalRunFlagError) {
          emitJson(program, fail(err.code, err.message));
          return;
        }
        throw err;
      }
      // #256: loaded extensions' chrome-extension://<id> origins are allowed too (only those ids).
      const allowlist = allowWithExtensions(o.url, resolveExploreAllowlist(setupRefFreeUrl(o.url), o.allow), browserLaunchFromFlags(o));
      // #543: an http end-state check reads only an origin the run allows (it is recorded in the
      // Journey's metadata.allowedOrigins from this same --allow list) — refused before anything opens.
      try {
        assertHttpChecksAllowed(successChecks, allowlist);
      } catch (err) {
        if (!(err instanceof HttpCheckOffAllowlistError)) throw err;
        emitJson(program, fail(err.code, err.message));
        return;
      }
      // #544: the fixture spec and every ${setup.x} reference are validated before any gateway or
      // browser; setup itself runs around each take.
      let fixtures: MissionFixtures | undefined;
      try {
        checkUrlRefOrigin(o.url);
        fixtures = buildMissionFixtures(o, {
          allowlist,
          baseUrl: setupRefFreeUrl(o.url),
          ...(o.storageState === undefined ? {} : { storageState: o.storageState }),
          secretFields: goalRun.secretFields ?? [],
          secrets: goalRun.secrets,
          ...(goalRun.target?.fixtures === undefined ? {} : { targetFixtures: goalRun.target.fixtures }),
          ...(goalRun.target?.personas === undefined ? {} : { personas: goalRun.target.personas }),
        });
        checkSetupRefs({ "--url": o.url, "--goal": o.goal, "--success": o.success }, fixtures);
      } catch (err) {
        if (!(err instanceof FixtureSpecError || err instanceof UnboundSetupRefError)) throw err;
        emitJson(program, fail(err.code, err.message));
        return;
      }
      const bounds: Record<string, number> = {};
      if (o.maxActions !== undefined) bounds.maxActions = Number(o.maxActions);
      if (o.maxDecisions !== undefined) bounds.maxDecisions = Number(o.maxDecisions);

      let judge: JudgmentPort;
      let gen: GenerationPort;
      let authorUsage: UsageTracker;
      try {
        ({ judge, gen, usage: authorUsage } = await buildExploreGateways(deps, { real: o.real ?? false, fakeAi: o.fakeAi ?? false, jevProvider: o.jevProvider }));
      } catch (err) {
        if (err instanceof MissingCredentialError || err instanceof GatewaySelectionError) {
          emitJson(program, fail("E_AI_SETUP_REQUIRED", err.message));
        } else {
          emitJson(program, fail("E_EXPLORE_SETUP", String(err instanceof Error ? err.message : err)));
        }
        return;
      }
      // #313: with --real the judge triages the signals; a fake gateway triages them by code.
      const authorGoalRun: GoalRunShaping = { ...goalRun, ...triagedServerLog(serverLog, judge, o.real === true) };
      // #585: the location flags (--project/--journeys-dir, deprecated --dir) resolve before the store is touched.
      const layout = journeyLayout(program, deps, { project: o.project, journeysDir: o.journeysDir });
      if (layout === null) return;

      try {
        const result = await runAuthorJourney({
          url: o.url,
          goal: o.goal,
          successChecks,
          allowlist,
          journeysDir: layout.journeysDir,
          journeyId: o.id,
          journeyName: o.name,
          takes: Number(o.takes),
          judge,
          gen,
          bounds: Object.keys(bounds).length > 0 ? bounds : undefined,
          browserPortFactory: deps.explore?.browserPortFactory,
          browser: browserLaunchFromFlags(o),
          ...(o.storageState !== undefined ? { storageState: o.storageState } : {}),
          goalRun: authorGoalRun,
          ...(fixtures === undefined ? {} : { fixtures, successSpecs: o.success }),
          ...(o.fixtures === undefined ? {} : { fixturesFile: o.fixtures }),
          ...(o.out === undefined ? {} : { outDir: o.out }),
          usage: authorUsage,
        })
          .then((r) => withLinkWarnings(r, layout.catalogDir))
          .then((r) => ({ ...r, usage: authorUsage.snapshot() }));
        const envelope = ok(result);
        if (o.json) {
          emitJson(program, envelope);
          if (result.outcome !== "authored") process.exitCode = 1;
        } else {
          writeHumanResult(program, result, formatAuthorJourneyHuman);
          process.exitCode = result.outcome === "authored" ? 0 : 1;
        }
      } catch (err) {
        if (err instanceof UnauthorizedExploreTargetError) {
          emitJson(program, fail("E_UNAUTHORIZED_EXPLORE_TARGET", err.message));
        } else if (err instanceof FixtureNotFoundError || err instanceof FixturePathError) {
          emitJson(program, fail("E_EXPLORE_FIXTURE", err.message));
        } else {
          emitJson(program, fail("E_AUTHOR_JOURNEY", String(err instanceof Error ? err.message : err)));
        }
      }
    });
}
