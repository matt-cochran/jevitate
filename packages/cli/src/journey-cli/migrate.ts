import { existsSync } from "node:fs";
import { Command } from "commander";
import { ok, fail } from "../envelope.js";
import { migrateStepIds, renderMigrateStepIds } from "../journey-migrate-api.js";
import { migrateLabels, renderMigrateLabels } from "../journey-labels-migrate-api.js";
import { resolveCatalogDir } from "../catalog-api.js";
import { withSiteGate } from "../site-gate-cli.js";
import { environmentFromFlags, isEnvironmentError, withEnvironmentFlags, type EnvironmentFlags, type ResolvedJourneyEnvironment } from "../environments.js";
import { type CliDeps, resolveDbPath, type BrowserLaunchFlags, withBrowserLaunchFlags, browserRunFromFlags, type DemoFlags, collectParam, emitJson, environmentSeams } from "../cli-shared.js";
import { withProjectFlags } from "../project-layout.js";
import { DEPRECATED_DIR_HELP, flaggedCatalogDir, journeyLayout } from "./shared.js";

/** Registers `jevitate journey migrate`. */
export function registerJourneyMigrate(journey: Command, program: Command, deps: CliDeps): void {
  // #467b — the one-time step-id backfill: CLI only (a repo rewrite the operator runs and commits; no MCP tool).
  // #497 — `--labels`: the opt-in label backfill; a real replay of each Journey (the app must be running). CLI only.
  withEnvironmentFlags(withBrowserLaunchFlags(withProjectFlags(journey.command("migrate"))))
    .description(
      "one-time repo rewrite, CLI only. #467: --step-ids mints a stable step id on every recorded step that has none (every Journey and recording in the project) and points anchors at them. #497: --labels REPLAYS the Journeys (the app must be running; side effects happen) and stores each step's visible label for the review sheet. Both change every promoted Journey's hash: re-approve them (journey review --stale). Never approves",
    )
    .option("--step-ids", "mint missing step ids")
    .option("--labels", "#497: replay the Journeys and store each step's visible label (exclusive with --step-ids; needs the app running)")
    .option("--id <id...>", "#497: with --labels, only these Journeys (default: every local Journey)")
    .option("--param <kv>", "#497: with --labels, a replay param as key=value (repeatable; each Journey gets only the ones it declares)", collectParam, {} as Record<string, string>)
    .option("--storage-state <file>", "#497: with --labels, Playwright storageState JSON to start the replays authenticated; must exist")
    .option("--dry-run", "report what would change, write nothing (with --labels the replay still runs)")
    .option("--dir <path>", DEPRECATED_DIR_HELP)
    .option("--json", "emit a JSON envelope")
    .action(async function (this: Command) {
      const locationFlags = this.opts<{ dir?: string; project?: string; journeysDir?: string }>();
      const layout = journeyLayout(program, deps, { dir: locationFlags.dir, project: locationFlags.project, journeysDir: locationFlags.journeysDir });
      if (layout === null) return;
      const migrateJourneysDir = layout.journeysDir;
      const { stepIds, labels, id: ids, param, storageState: storageStateFlag, dryRun, json } = this.opts<{
        stepIds?: boolean;
        labels?: boolean;
        id?: string[];
        param: Record<string, string>;
        storageState?: string;
        dryRun?: boolean;
        json?: boolean;
      }>();
      if (labels === true && stepIds === true) {
        emitJson(program, fail("E_JOURNEY_MIGRATE_ARGS", "--labels and --step-ids are exclusive: run one migration at a time"));
        return;
      }
      if (stepIds !== true && labels !== true) {
        emitJson(program, fail("E_JOURNEY_MIGRATE_ARGS", "name the migration: --step-ids or --labels"));
        return;
      }
      if (labels !== true) {
        const labelOnly = [ids !== undefined ? "--id" : "", Object.keys(param).length > 0 ? "--param" : "", storageStateFlag !== undefined ? "--storage-state" : "", this.opts<EnvironmentFlags>().env !== undefined ? "--env" : "", this.opts<EnvironmentFlags>().baseUrl !== undefined ? "--base-url" : ""].filter((f) => f !== "");
        if (labelOnly.length > 0) {
          emitJson(program, fail("E_JOURNEY_MIGRATE_ARGS", `${labelOnly.join(", ")} only apply to --labels (the replay); --step-ids does not run the app`));
          return;
        }
        try {
          const result = await migrateStepIds({ journeysDir: migrateJourneysDir, projectDir: resolveCatalogDir(deps.catalogDir, flaggedCatalogDir(layout)), dryRun: dryRun === true });
          if (json) emitJson(program, ok(result));
          else program.configureOutput().writeOut?.(renderMigrateStepIds(result));
          process.exitCode = 0;
        } catch (err) {
          emitJson(program, fail("E_JOURNEY_MIGRATE", String(err instanceof Error ? err.message : err)));
        }
        return;
      }
      const { env: envName, baseUrl } = this.opts<EnvironmentFlags>();
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
        emitJson(program, fail("E_JOURNEY_MIGRATE_ARGS", `storage state not found: ${storageState}`));
        return;
      }
      let browser: ReturnType<typeof browserRunFromFlags>;
      try {
        browser = browserRunFromFlags(this.opts<BrowserLaunchFlags & DemoFlags>(), deps.explore?.env ?? process.env);
      } catch (err) {
        emitJson(program, fail("E_JOURNEY_MIGRATE_ARGS", err instanceof Error ? err.message : String(err)));
        return;
      }
      try {
        const result = await withSiteGate(resolveDbPath(deps), (siteGate) =>
          migrateLabels({
            journeysDir: migrateJourneysDir,
            ...(ids === undefined ? {} : { ids }),
            dryRun: dryRun === true,
            params: param,
            run: {
              ...(siteGate === undefined ? {} : { siteGate }),
              ...(deps.explore?.browserPortFactory === undefined ? {} : { browserPortFactory: deps.explore.browserPortFactory }),
              ...(browser === undefined ? {} : { browser }),
              ...(storageState === undefined ? {} : { storageState }),
              ...(environment === undefined ? {} : { environment }),
            },
          }),
        );
        if (json) emitJson(program, ok(result));
        else program.configureOutput().writeOut?.(renderMigrateLabels(result));
        process.exitCode = 0;
      } catch (err) {
        emitJson(program, fail("E_JOURNEY_MIGRATE", String(err instanceof Error ? err.message : err)));
      }
    });
}
