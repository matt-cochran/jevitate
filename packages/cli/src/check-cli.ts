import { JEV_PROVIDER_FLAG_HELP, jevProviderArg } from "./cli-shared.js";
import { TAG_FLAG, TAG_HELP, collectTag, taggedAction } from "./run-tags-cli.js";
import type { Command } from "commander";
import { MissingCredentialError, formatUsageLine } from "@jevitate/ai-core";
import type { BrowserLaunchOptions, BrowserPort } from "@jevitate/playwright";
import { ok, fail, type JsonEnvelope } from "./envelope.js";
import { emitEnvelope } from "./cli-output.js";
import { CheckAiSetupError, CheckPreflightError, runCheck, type CheckGateways, type CheckRunners } from "./check-api.js";
import { SuiteError, loadSuite } from "./check-suite.js";
import { ReportInputError, defaultResultDirs } from "./report-api.js";
import { TargetConfigError, loadTargetsFile } from "./target-config.js";

/**
 * `jevitate check --suite <file.json>` (#137). Registered by `program.ts`; its model gateways and
 * browser wiring come in through `CheckCliDeps` so this file never builds a gateway itself.
 *
 * Exit codes (exit-codes.ts): 0 pass · 1 a gating (hard, or new vs `--baseline`) finding · 2 no
 * gating finding but an item errored, the budget was exceeded, or the check itself failed · 64 the
 * suite, preflight, targets file or AI setup was refused (a usage/input error: nothing ran).
 */

export interface CheckCliDeps {
  /** Builds the explore gateways for `--real` / `--fake-ai` (program.ts's `buildExploreGateways`). */
  readonly buildGateways: (sel: { real: boolean; fakeAi: boolean; jevProvider?: string | undefined }) => Promise<CheckGateways>;
  readonly journeysDir: string;
  /** The site-policy database (`jevitate site policy set`) Journey items are gated by. */
  readonly sitePolicyDbPath?: string;
  readonly targetsConfigPath?: string;
  /** #247: the environments file a Journey item's `env` names (default: the repo's `.jevitate/environments.json`). */
  readonly environmentsFile?: string;
  readonly browserPortFactory?: () => BrowserPort;
  /** Maps the command's browser launch flags to launch options (program.ts's `browserLaunchFromFlags`). */
  readonly browserLaunch?: (flags: object) => BrowserLaunchOptions | undefined;
  readonly baselinesDir?: string;
  /** Test seam: replace the runners. */
  readonly runners?: Partial<CheckRunners>;
}

/** #210: the envelope with --json; a refusal without it is an `error <CODE>: …` line (exit-codes.ts class). */
function emit(program: Command, envelope: JsonEnvelope<unknown>, json: boolean, exitCode?: number): void {
  emitEnvelope(program, envelope, { json, command: "check", ...(exitCode === undefined ? {} : { exitCode }) });
}

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
    .option("--baseline <run|tag|last>", "only findings NOT in this baseline gate (a run, a `baseline tag`, or `last`)")
    .option("--baseline-dir <dir>", "results dir holding baseline runs (repeatable; default: this check's results, then ~/.jevitate)", collect, [] as string[])
    .option("--changed-routes <globs>", "only run Journeys and goals touching these route globs (comma list, repeatable), e.g. '/settings/**'", collectList, [] as string[])
    .option("--out <dir>", "output dir: results/, junit.xml, jevitate.sarif, report.md, check.json", "jevitate-check")
    .option("--junit <path>", "JUnit XML path (default <out>/junit.xml)")
    .option("--sarif <path>", "SARIF path (default <out>/jevitate.sarif)")
    .option("--json-out <path>", "JSON envelope path (default <out>/check.json)")
    .option("--real", "use live Jev + OpenRouter gateways for goals and model-driven missions (requires keys)", false)
    .option("--fake-ai", "use deterministic fake gateways (pipeline smoke only)", false)
    .option("--jev-provider <provider>", JEV_PROVIDER_FLAG_HELP, jevProviderArg)
    .option("--json", "emit the JSON envelope (default: a one-line summary per item, then the envelope path)")
    .option(TAG_FLAG, TAG_HELP, collectTag, [])
    .action(taggedAction(program, "check", async function (this: Command) {
      const o = this.opts<{
        suite: string;
        targetBuild?: string;
        baseline?: string;
        baselineDir: string[];
        changedRoutes: string[];
        out: string;
        junit?: string;
        sarif?: string;
        jsonOut?: string;
        real?: boolean;
        fakeAi?: boolean;
        jevProvider?: string;
        json?: boolean;
      }>();
      try {
        const suite = loadSuite(o.suite);
        const real = o.real === true || (o.fakeAi !== true && suite.ai === "real");
        const fakeAi = o.fakeAi === true || (o.real !== true && suite.ai === "fake");
        const aiMode = real ? "real" : fakeAi ? "fake" : undefined;
        const jevProvider = o.jevProvider;
        const browser = deps.browserLaunch?.(this.opts());
        const result = await runCheck({
          suite,
          suiteUri: o.suite,
          outDir: o.out,
          journeysDir: deps.journeysDir,
          ...(deps.sitePolicyDbPath === undefined ? {} : { sitePolicyDbPath: deps.sitePolicyDbPath }),
          targetsConfig: loadTargetsFile(deps.targetsConfigPath),
          ...(deps.environmentsFile === undefined ? {} : { environmentsFile: deps.environmentsFile }),
          ...(o.targetBuild === undefined ? {} : { targetBuild: o.targetBuild }),
          ...(o.baseline === undefined ? {} : { baseline: o.baseline }),
          ...(o.baselineDir.length > 0 ? { baselineDirs: o.baselineDir } : o.baseline === undefined ? {} : { baselineDirs: [`${o.out}/results`, ...defaultResultDirs()] }),
          ...(deps.baselinesDir === undefined ? {} : { baselinesDir: deps.baselinesDir }),
          ...(o.changedRoutes.length > 0 ? { changedRoutes: o.changedRoutes } : {}),
          ...(o.junit === undefined ? {} : { junitPath: o.junit }),
          ...(o.sarif === undefined ? {} : { sarifPath: o.sarif }),
          ...(o.jsonOut === undefined ? {} : { jsonPath: o.jsonOut }),
          ...(aiMode === undefined ? {} : { aiMode, gateways: () => deps.buildGateways({ real, fakeAi, jevProvider }) }),
          ...(deps.browserPortFactory === undefined ? {} : { browserPortFactory: deps.browserPortFactory }),
          ...(browser === undefined ? {} : { browser }),
          ...(deps.runners === undefined ? {} : { runners: deps.runners }),
        });
        if (o.json) emit(program, ok(result), true, result.exitCode);
        else {
          const out = program.configureOutput().writeOut;
          const findingTitle = new Map(result.findings.map((f) => [f.key, f.title]));
          for (const i of result.items) {
            const reason =
              i.error !== undefined
                ? ` — ${i.error.message}`
                : i.verdict === "failed" && i.gating.length > 0
                  ? ` — ${i.gating.map((k) => findingTitle.get(k) ?? k).join("; ")}`
                  : "";
            out?.(`${i.verdict.toUpperCase().padEnd(7)} ${i.target} ${i.kind} ${i.name}${reason}\n`);
          }
          // #213: 0 calls is nothing to report (not $0 vs "unpriced" noise) — omit the line entirely.
          if (result.usage !== undefined && result.usage.judgments + result.usage.generations > 0) {
            out?.(`COST    ${formatUsageLine(result.usage)}\n`);
          }
          if (result.budget.exceeded !== undefined) out?.(`BUDGET  ${result.budget.exceeded}\n`);
          // #213: exit 2 (an item errored, or the budget ran out, but no gating finding) is never
          // headed FAIL — that reads as a defect was found when the run simply proved nothing.
          const headline =
            result.exitCode === 0
              ? `PASS: ${result.summary.gatingFindings} gating finding(s)`
              : result.exitCode === 1
                ? `FAIL: ${result.summary.gatingFindings} gating finding(s)`
                : result.summary.errors > 0
                  ? `ERROR: ${result.summary.errors} item(s) errored${result.budget.exceeded === undefined ? "" : " · budget exceeded"}`
                  : `INCONCLUSIVE: ${result.budget.exceeded ?? "the budget was exceeded before every item ran"}`;
          out?.(`${headline} · ${result.jsonPath}\n`);
          out?.(result.summary.gatingFindings > 0 ? "next: jevitate report (the findings by fingerprint) · jevitate verify-fix <fp> after a fix\n" : "next: jevitate report\n");
          process.exitCode = result.exitCode;
        }
      } catch (err) {
        if (
          err instanceof SuiteError ||
          err instanceof CheckPreflightError ||
          err instanceof CheckAiSetupError ||
          err instanceof ReportInputError ||
          err instanceof TargetConfigError
        ) {
          emit(program, fail(err.code, err.message), o.json === true);
        } else if (err instanceof MissingCredentialError || (err instanceof Error && err.name === "GatewaySelectionError")) {
          emit(program, fail("E_AI_SETUP_REQUIRED", err.message), o.json === true);
        } else {
          emit(program, fail("E_CHECK", err instanceof Error ? err.message : String(err)), o.json === true);
        }
      }
    }));
}
