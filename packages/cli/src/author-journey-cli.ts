import { existsSync } from "node:fs";
import { Command } from "commander";
import { MissingCredentialError, UsageTracker, type JudgmentPort, type GenerationPort } from "@jevitate/ai-core";
import { FixtureNotFoundError, UnauthorizedExploreTargetError, type AuthorJourneyResult, type AuthorTakeDiagnostics, type SuccessCheck } from "@jevitate/explore";
import { ok, fail } from "./envelope.js";
import { positiveIntArg } from "./cli-args.js";
import { runAuthorJourney, parseSuccessSpec, resolveExploreAllowlist } from "./explore-api.js";
import { allowWithExtensions } from "./browser-run-options.js";
import {
  type CliDeps,
  resolveJourneysDir,
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
import { GOAL_RUN_OPTIONS, GoalRunFlagError, resolveGoalRunFlags, type GoalRunFlags, type GoalRunShaping } from "./goal-run-flags.js";

/**
 * #369: the goal-run flags `explore-author-journey` shares with `explore` — every take is that goal
 * run, so it can reproduce whatever setup the goal run needed (in `explore`'s own order).
 */
const AUTHOR_GOAL_RUN_FLAGS = [
  "successWhen", "allowVacuousChecks", "actionDeltas", "secret", "secretField", "totp", "typeFixture", "fixture",
  "saveStorageState", "replyWaitMs", "replyQuietMs", "replyCeilingMs", "replyMaxChars", "jobWaitMs", "deny", "paid",
  "allowDestructive", "dialogs", "readRpc", "hangReplays", "settleIgnore", "longPollMs", "apiPrefix", "ignoreNoProgress",
  "allowSecretCmd", "secretCmdAttempts",
] as const satisfies readonly (keyof typeof GOAL_RUN_OPTIONS)[];

/** `reloadThen:<check>` → the inner `<check>` (what the Journey CAN assert). */
const innerOfReloadThen = (spec: string): string => spec.replace(/^\s*reloadThen:/, "");

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
export function formatAuthorJourneyHuman(data: unknown): string {
  const r = data as AuthorJourneyResult;
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
  return `${lines.join("\n")}\n`;
}

/** Registers `jevitate explore-author-journey` (Jev authors an unpromoted, parameterized Journey). */
export function registerAuthorJourneyCommands(program: Command, deps: CliDeps): void {
  // Additive: `explore author-journey` — Jev-driving authors a promotable
  // Journey (Ticket #6). Drives the goal-based mission, feeds its take(s)
  // through RxD's diff/postdoc pipeline, and writes an UNPROMOTED,
  // parameterized Journey to the journeys store. The record-by-demonstration
  // authoring path is untouched.
  const cmd = withBrowserLaunchFlags(
    program
      .command("explore-author-journey")
      .description("Jev-driving authors a promotable Journey (authoring plane); never auto-promoted"),
  )
    .option("--url <url>", "target URL (must be an authorized origin)")
    .option("--goal <text>", "natural-language goal")
    .option(
      "--success <spec>",
      "independent success check (repeatable; all must hold), any explore --success kind but reloadThen, e.g. urlIncludes:/confirmed or " +
        "'requestMade:POST /api/save': a page check becomes the Journey's last assert step, a requestMade/responseStatus check is re-checked over every replay's requests",
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
    .option("--journeys-dir <dir>", "journeys store directory (default: the repo's .jevitate/journeys; outside a repo ~/.jevitate/journeys)")
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
    .option("--json", "emit a JSON envelope");
  // #369: every take is `explore`'s goal run, so author takes its run-shaping flags too.
  for (const name of AUTHOR_GOAL_RUN_FLAGS) cmd.addOption(GOAL_RUN_OPTIONS[name]());
  withScreenshotsFlag(withEmulationFlags(cmd))
    .addHelpText(
      "after",
      [
        "",
        "Each take is a full goal run (the same runner and run-shaping flags as `jevitate explore --strategy goal`),",
        "writing its own result, transcript and Recording (under --out). A take that does not reach the goal",
        "is reported with its stop reason, its checks' verdicts and those paths. A field code types itself",
        "(--secret-field/--totp) becomes a secret Journey parameter (secret1, …), passed with --param at replay.",
        "A reloadThen: check is refused before any browser opens: author with its inner check instead.",
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
        journeysDir?: string;
        allow: string[];
        maxActions?: string;
        maxDecisions?: string;
        real?: boolean;
        fakeAi?: boolean;
        json?: boolean;
        storageState?: string;
        out?: string;
      } & BrowserLaunchFlags & GoalRunFlags>();
      if (o.storageState !== undefined && !existsSync(o.storageState)) {
        emitJson(program, fail("E_EXPLORE_ARGS", `storage state not found: ${o.storageState}`));
        return;
      }

      if (!o.url || !o.goal || o.success.length === 0 || !o.id || !o.name) {
        emitJson(program, fail("E_AUTHOR_ARGS", "--url, --goal, --success, --id and --name are all required"));
        return;
      }
      // #322: every kind `explore --success` takes — page and network checks — but reloadThen.
      const successChecks: SuccessCheck[] = [];
      try {
        for (const spec of o.success) {
          const check = parseSuccessSpec(spec);
          if (check.kind === "reloadThen") {
            // #369: refused here, before any gateway or browser — a Journey has no reload step to re-check after.
            throw new Error(
              `--success ${JSON.stringify(spec)}: a reloadThen check can't be authored into a Journey (a Journey has no reload step); nothing was run. ` +
                `Author with its inner check (--success ${JSON.stringify(innerOfReloadThen(spec))}) and prove persistence with \`jevitate explore --success ${JSON.stringify(spec)}\`, ` +
                "or use a requestMade/responseStatus check",
            );
          }
          successChecks.push(check);
        }
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
      // #256: loaded extensions' chrome-extension://<id> origins are allowed too (only those ids).
      const allowlist = allowWithExtensions(o.url, resolveExploreAllowlist(o.url, o.allow), browserLaunchFromFlags(o));
      const bounds: Record<string, number> = {};
      if (o.maxActions !== undefined) bounds.maxActions = Number(o.maxActions);
      if (o.maxDecisions !== undefined) bounds.maxDecisions = Number(o.maxDecisions);

      let judge: JudgmentPort;
      let gen: GenerationPort;
      let authorUsage: UsageTracker;
      try {
        ({ judge, gen, usage: authorUsage } = await buildExploreGateways(deps, { real: o.real ?? false, fakeAi: o.fakeAi ?? false }));
      } catch (err) {
        if (err instanceof MissingCredentialError || err instanceof GatewaySelectionError) {
          emitJson(program, fail("E_AI_SETUP_REQUIRED", err.message));
        } else {
          emitJson(program, fail("E_EXPLORE_SETUP", String(err instanceof Error ? err.message : err)));
        }
        return;
      }

      try {
        const result = await runAuthorJourney({
          url: o.url,
          goal: o.goal,
          successChecks,
          allowlist,
          journeysDir: resolveJourneysDir(deps, o.journeysDir),
          journeyId: o.id,
          journeyName: o.name,
          takes: Number(o.takes),
          judge,
          gen,
          bounds: Object.keys(bounds).length > 0 ? bounds : undefined,
          browserPortFactory: deps.explore?.browserPortFactory,
          browser: browserLaunchFromFlags(o),
          ...(o.storageState !== undefined ? { storageState: o.storageState } : {}),
          goalRun,
          ...(o.out === undefined ? {} : { outDir: o.out }),
          usage: authorUsage,
        }).then((r) => ({ ...r, usage: authorUsage.snapshot() }));
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
        } else if (err instanceof FixtureNotFoundError) {
          emitJson(program, fail("E_EXPLORE_FIXTURE", err.message));
        } else {
          emitJson(program, fail("E_AUTHOR_JOURNEY", String(err instanceof Error ? err.message : err)));
        }
      }
    });
}
