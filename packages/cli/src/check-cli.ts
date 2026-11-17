import { JEV_PROVIDER_FLAG_HELP, jevProviderArg } from "./cli-shared.js";
import { TAG_FLAG, TAG_HELP, collectTag, taggedAction } from "./run-tags-cli.js";
import type { Command } from "commander";
import { ok, fail } from "./envelope.js";
import { resolveCatalogDir } from "./catalog-api.js";
import { nonNegativeIntArg, positiveIntArg } from "./cli-args.js";
import { existsSync } from "node:fs";
import { ALLOW_CHANNELS_HELP } from "./catalog-cli.js";
import { locatorHealth, renderLocatorHealth } from "./locator-health-api.js";
import { emit, runCheckCommandAction } from "./check-cli-action.js";
import type { CheckCliDeps } from "./check-cli-action.js";

export type { CheckCliDeps } from "./check-cli-action.js";

/**
 * `jevitate check --suite <file.json>` (#137). Registered by `program.ts`; its model gateways and
 * browser wiring come in through `CheckCliDeps` so this file never builds a gateway itself.
 *
 * Exit codes (exit-codes.ts): 0 pass · 1 a gating (hard, or new vs `--baseline`) finding · 2 no
 * gating finding but an item errored, the budget was exceeded, or the check itself failed · 64 the
 * suite, preflight, targets file or AI setup was refused (a usage/input error: nothing ran) · 5 (#453,
 * `--self-heal`) nothing failed but a re-run proposed a Journey revision awaiting review. Precedence 1 > 2 > 5 > 0.
 */

const collect = (v: string, prev: string[]): string[] => [...prev, v];
const collectList = (v: string, prev: string[]): string[] => [...prev, ...v.split(",").map((s) => s.trim()).filter((s) => s !== "")];

export function registerCheckCommand(program: Command, deps: CheckCliDeps, withLaunchFlags: (cmd: Command) => Command): void {
  withLaunchFlags(
    program
      .command("check")
      .description("CI regression gate: run a suite of Journeys, invariants, goals and missions within a budget; JUnit + SARIF + JSON"),
  )
    .requiredOption("--suite <file>", "the suite JSON (targets, promoted Journeys, invariant files, goals, missions, budget)")
    .option("--target-build <id>", "the target's build/commit id, stamped on every result")
    .option("--app-version <label>", "#479: the app's release/version label the check ran against, stamped next to the build id (1-64 of [A-Za-z0-9._+-]); also JEVITATE_APP_VERSION")
    .option("--baseline <run|tag|last>", "only findings NOT in this baseline gate (a run, a `baseline tag`, or `last`)")
    .option("--baseline-dir <dir>", "results dir holding baseline runs (repeatable; default: this check's results, then ~/.jevitate)", collect, [] as string[])
    .option("--changed-routes <globs>", "only run Journeys and goals touching these route globs (comma list, repeatable), e.g. '/settings/**'", collectList, [] as string[])
    .option("--evidence-input <file>", "#704 immutable proof identity JSON; required to consume or emit an evidence manifest")
    .option("--evidence-manifest <file>", "#704 prior content-addressed evidence manifest to reuse when its identity exactly matches")
    .option("--evidence-out <file>", "#704 write a content-addressed success manifest after this clean check")
    .option("--evidence-decision-out <file>", "#704 write a machine-readable run|skip decision and changed-input reasons, then exit before browser/model work")
    .option("--out <dir>", "output dir: results/, junit.xml, jevitate.sarif, report.md, check.json", "jevitate-check")
    .option("--junit <path>", "JUnit XML path (default <out>/junit.xml)")
    .option("--sarif <path>", "SARIF path (default <out>/jevitate.sarif)")
    .option("--json-out <path>", "JSON envelope path (default <out>/check.json)")
    .option("--real", "use live Jev + OpenRouter gateways for goals and model-driven missions (requires keys)", false)
    .option("--fake-ai", "use deterministic fake gateways (pipeline smoke only)", false)
    .option("--jev-provider <provider>", JEV_PROVIDER_FLAG_HELP, jevProviderArg)
    .option("--json", "emit the JSON envelope (default: a one-line summary per item, then the envelope path)")
    .option(TAG_FLAG, TAG_HELP, collectTag, [])
    .option("--self-heal <mode>", "#453: fail-closed | hybrid | full — re-run a Journey that quarantined ONCE with a change-aware self-heal (needs --changes and/or --change-note, and --real/--fake-ai); a proposed revision is pending review (exit 5), never a pass", "fail-closed")
    .option("--changes <range>", "#453: the git range that explains a break (e.g. main...HEAD; read once, in the journeys dir's repo) — needs --self-heal hybrid|full")
    .option("--change-note <text>", "#453: a change note that explains a break (repeatable) — needs --self-heal hybrid|full", collect, [] as string[])
    .option("--heal-max-attempts <n>", "#453: candidates tried per broken step (default 2)", positiveIntArg)
    .option("--heal-max-model-calls <n>", "#453: model calls per broken step (default 6)", positiveIntArg)
    .option("--heal-max-ms <ms>", "#453: healing time per broken step in ms (default 60000)", positiveIntArg)
    .option("--heal-max-run-attempts <n>", "#453: candidates tried per re-run (default 4)", positiveIntArg)
    .option("--heal-max-run-ms <ms>", "#453: healing time per re-run in ms (default 180000)", positiveIntArg)
    .option(
      "--require-approvals",
      "#437: also fail (an `approval` finding, exit 1, in JUnit + SARIF) when a promoted Journey or an approved persona/job has a missing or stale approval, or one made over a channel not allowed",
    )
    .option("--allow-channels <list>", ALLOW_CHANNELS_HELP)
    .option("--require-trust", "#799: fail (exit 1, naming the environment) when an environment's `trust` in .jevitate/environments.json differs from the last commit; a change of trust is committed (PR-reviewed) first")
    .option(
      "--max-brittle-steps <n>",
      "#470: opt-in locator gate — a Journey item with more than n brittle steps (targets that miss the project's testIdAttributes convention) is a gating finding. Without it locator health is advisory only",
      nonNegativeIntArg,
    )
    .option("--no-done-check", "H5 (0.30.0): skip each Journey item's job done check; every job reads unverified (basis no-check), which holds the check at exit 2 unless project.json doneCheckPolicy is advisory")
    .option("--require-done-check", "H5 (0.30.0): a Journey item that passes with an unverified job holds the check at exit 2 even when project.json doneCheckPolicy is advisory")
    .action(taggedAction(program, "check", async function (this: Command) {
      await runCheckCommandAction.call(this, program, deps);
    }));

  registerLocatorHealthCommand(program, deps);
}

/**
 * #470: `jevitate locator-health` — read-only and advisory: how stable each recorded step's target is
 * against the project's test-id convention (`testIdAttributes` in project config; never a flag). MCP
 * `locator_health` mirrors it. It never gates (exit 0 on any report); `check --max-brittle-steps` is the gate.
 */
function registerLocatorHealthCommand(program: Command, deps: CheckCliDeps): void {
  program
    .command("locator-health")
    .description(
      "#470: read-only locator health — per step, the selector rung its target resolves by and whether it meets the project's test-id convention (testIdAttributes in project config; default data-testid, data-test; data-tflow-id never counts). Every promoted Journey, one Journey (--journey) or one run (--run). Advisory: never gates",
    )
    .option("--journey <id>", "only this Journey")
    .option("--run <result.json>", "the steps of this run result instead of the stored Journeys")
    .option("--baseline <file>", "a previous locator-health --json output (or a run result.json) to report the trend against: steps improved / regressed")
    .option("--dir <path>", "journeys directory (default: the repo's .jevitate/journeys; outside a repo ~/.jevitate/journeys)")
    .option("--json", "emit a JSON envelope")
    .action(async function (this: Command) {
      const o = this.opts<{ journey?: string; run?: string; baseline?: string; dir?: string; json?: boolean }>();
      const json = o.json === true;
      if (o.journey !== undefined && o.run !== undefined) {
        emit(program, fail("E_LOCATOR_HEALTH_ARGS", "--journey and --run are exclusive: pick one source"), json);
        return;
      }
      if (o.journey !== undefined && (o.journey.includes("..") || !/^[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*)?$/.test(o.journey))) {
        emit(program, fail("E_LOCATOR_HEALTH_ARGS", `--journey must be a Journey id, got ${JSON.stringify(o.journey)}`), json);
        return;
      }
      if (o.run !== undefined && !existsSync(o.run)) {
        emit(program, fail("E_LOCATOR_HEALTH_INPUT", `--run: no such result file: ${o.run}`), json);
        return;
      }
      try {
        const report = await locatorHealth({
          journeysDir: o.dir ?? deps.journeysDir,
          projectDir: resolveCatalogDir(deps.catalogDir),
          ...(o.journey === undefined ? {} : { journeyId: o.journey }),
          ...(o.run === undefined ? {} : { runResult: o.run }),
          ...(o.baseline === undefined ? {} : { baseline: o.baseline }),
        });
        if (json) emit(program, ok(report), true, 0);
        else {
          program.configureOutput().writeOut?.(renderLocatorHealth(report));
          process.exitCode = 0;
        }
      } catch (err) {
        // #470: a typed refusal keeps its code (E_PROJECT_CONFIG, E_LOCATOR_HEALTH_INPUT).
        const own = (err as { code?: unknown }).code;
        const code = typeof own === "string" && own.startsWith("E_") ? own : "E_LOCATOR_HEALTH";
        emit(program, fail(code, err instanceof Error ? err.message : String(err)), json);
      }
    });
}
