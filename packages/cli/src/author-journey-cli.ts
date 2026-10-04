import { existsSync } from "node:fs";
import { Command } from "commander";
import { MissingCredentialError, UsageTracker, type JudgmentPort, type GenerationPort } from "@jevitate/ai-core";
import { UnauthorizedExploreTargetError, type SuccessCheck } from "@jevitate/explore";
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
  writeRawResult,
  GatewaySelectionError,
  buildExploreGateways,
} from "./cli-shared.js";

/** Registers `jevitate explore-author-journey` (Jev authors an unpromoted, parameterized Journey). */
export function registerAuthorJourneyCommands(program: Command, deps: CliDeps): void {
  // Additive: `explore author-journey` — Jev-driving authors a promotable
  // Journey (Ticket #6). Drives the goal-based mission, feeds its take(s)
  // through RxD's diff/postdoc pipeline, and writes an UNPROMOTED,
  // parameterized Journey to the journeys store. The record-by-demonstration
  // authoring path is untouched.
  withBrowserLaunchFlags(
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
    .option("--real", "use live Jev + OpenRouter gateways (requires keys)", false)
    .option("--fake-ai", "use deterministic fake gateways (pipeline smoke only)", false)
    .option("--json", "emit a JSON envelope")
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
      } & BrowserLaunchFlags>();
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
            throw new Error(
              `${JSON.stringify(spec)}: reloadThen can't be authored into a Journey yet — use a page check or a requestMade/responseStatus check`,
            );
          }
          successChecks.push(check);
        }
      } catch (err) {
        emitJson(program, fail("E_EXPLORE_ASSERTION", String(err instanceof Error ? err.message : err)));
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
        }).then((r) => ({ ...r, usage: authorUsage.snapshot() }));
        const envelope = ok(result);
        if (o.json) {
          emitJson(program, envelope);
          if (result.outcome !== "authored") process.exitCode = 1;
        } else {
          writeRawResult(program, result);
          process.exitCode = result.outcome === "authored" ? 0 : 1;
        }
      } catch (err) {
        if (err instanceof UnauthorizedExploreTargetError) {
          emitJson(program, fail("E_UNAUTHORIZED_EXPLORE_TARGET", err.message));
        } else {
          emitJson(program, fail("E_AUTHOR_JOURNEY", String(err instanceof Error ? err.message : err)));
        }
      }
    });
}
