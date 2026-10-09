import { JEV_PROVIDER_FLAG_HELP, jevProviderArg } from "./cli-shared.js";
import { TAG_FLAG, TAG_HELP, collectTag, taggedAction } from "./run-tags-cli.js";
import type { Command } from "commander";
import { MissingCredentialError, formatUsageLine } from "@jevitate/ai-core";
import type { BrowserLaunchOptions, BrowserPort } from "@jevitate/playwright";
import { ok, fail, type JsonEnvelope } from "./envelope.js";
import { emitEnvelope } from "./cli-output.js";
import { CheckAiSetupError, CheckArgsError, CheckPreflightError, runCheck, type CheckGateways, type CheckRunners } from "./check-api.js";
import { SuiteError, loadSuite } from "./check-suite.js";
import { ReportInputError, defaultResultDirs } from "./report-api.js";
import { TargetConfigError, loadTargetsFile } from "./target-config.js";
import { ApprovalArgsError, parseAllowedChannels } from "./approval-provenance.js";
import { resolveCatalogDir } from "./catalog-api.js";
import { nonNegativeIntArg, positiveIntArg } from "./cli-args.js";
import { existsSync } from "node:fs";
import { ALLOW_CHANNELS_HELP } from "./catalog-cli.js";
import { brittleStepGate, locatorHealth, renderLocatorHealth } from "./locator-health-api.js";
import { ChangesArgsError, ChangesInputError } from "./change-context.js";
import { CLI_HEAL_NAMES, JourneyHealArgsError, validateJourneyHeal, type JourneyHealRequest } from "./journey-heal.js";
import type { SelfHealMode } from "@jevitate/domain";

/**
 * `jevitate check --suite <file.json>` (#137). Registered by `program.ts`; its model gateways and
 * browser wiring come in through `CheckCliDeps` so this file never builds a gateway itself.
 *
 * Exit codes (exit-codes.ts): 0 pass · 1 a gating (hard, or new vs `--baseline`) finding · 2 no
 * gating finding but an item errored, the budget was exceeded, or the check itself failed · 64 the
 * suite, preflight, targets file or AI setup was refused (a usage/input error: nothing ran) · 5 (#453,
 * `--self-heal`) nothing failed but a re-run proposed a Journey revision awaiting review. Precedence 1 > 2 > 5 > 0.
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
  /** #437: the catalog's directory `--require-approvals` reads (default: the project's `.jevitate/`). */
  readonly catalogDir?: string;
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
    .option(
      "--max-brittle-steps <n>",
      "#470: opt-in locator gate — a Journey item with more than n brittle steps (targets that miss the project's testIdAttributes convention) is a gating finding. Without it locator health is advisory only",
      nonNegativeIntArg,
    )
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
        requireApprovals?: boolean;
        allowChannels?: string;
        selfHeal: string;
        changes?: string;
        changeNote: string[];
        healMaxAttempts?: number;
        healMaxModelCalls?: number;
        healMaxMs?: number;
        healMaxRunAttempts?: number;
        healMaxRunMs?: number;
        maxBrittleSteps?: number;
      }>();
      try {
        // #453: refused (64) before the suite is read or anything runs.
        if (o.selfHeal !== "fail-closed" && o.selfHeal !== "hybrid" && o.selfHeal !== "full") {
          throw new CheckArgsError(`--self-heal must be one of fail-closed | hybrid | full (got '${o.selfHeal}')`);
        }
        const healRequest: JourneyHealRequest = {
          selfHeal: o.selfHeal as SelfHealMode,
          ...(o.changes === undefined ? {} : { changes: o.changes }),
          changeNotes: o.changeNote,
          ...(o.healMaxAttempts === undefined ? {} : { maxAttempts: o.healMaxAttempts }),
          ...(o.healMaxModelCalls === undefined ? {} : { maxModelCalls: o.healMaxModelCalls }),
          ...(o.healMaxMs === undefined ? {} : { maxMs: o.healMaxMs }),
          ...(o.healMaxRunAttempts === undefined ? {} : { maxRunAttempts: o.healMaxRunAttempts }),
          ...(o.healMaxRunMs === undefined ? {} : { maxRunMs: o.healMaxRunMs }),
        };
        try {
          validateJourneyHeal(healRequest, CLI_HEAL_NAMES);
        } catch (e) {
          throw e instanceof JourneyHealArgsError ? new CheckArgsError(e.message) : e;
        }
        if (o.allowChannels !== undefined && o.requireApprovals !== true) throw new ApprovalArgsError("--allow-channels needs --require-approvals");
        const allowedChannels = o.requireApprovals === true ? parseAllowedChannels(o.allowChannels) : undefined;
        // #470: the opt-in brittle-step gate, resolved before the suite is read or anything runs.
        const gate = o.maxBrittleSteps === undefined ? undefined : brittleStepGate(o.maxBrittleSteps);
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
          ...(healRequest.selfHeal === "fail-closed" ? {} : { selfHeal: healRequest }),
          ...(allowedChannels === undefined ? {} : { requireApprovals: { allowedChannels, catalogDir: resolveCatalogDir(deps.catalogDir) } }),
          ...(gate === undefined ? {} : { maxBrittleSteps: gate.maxBrittleSteps }),
          projectDir: resolveCatalogDir(deps.catalogDir),
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
          // #470: locator health (advisory unless --max-brittle-steps), and its trend against --baseline.
          const lh = result.locatorHealth;
          if (lh?.line !== undefined) {
            const gateNote = lh.maxBrittleSteps === undefined ? " (advisory)" : lh.exceeded === true ? ` — exceeds --max-brittle-steps ${lh.maxBrittleSteps}` : ` (within --max-brittle-steps ${lh.maxBrittleSteps})`;
            out?.(`LOCATOR ${lh.line}${gateNote}\n`);
          }
          if (lh?.trend !== undefined) out?.(`LOCATOR ${lh.trend.line}\n`);
          // #213: exit 2 (an item errored, or the budget ran out, but no gating finding) is never
          // headed FAIL — that reads as a defect was found when the run simply proved nothing.
          const headline =
            result.exitCode === 0
              ? `PASS: ${result.summary.gatingFindings} gating finding(s)`
              : result.exitCode === 5
                ? `PENDING REVIEW: ${result.summary.pendingReview} Journey revision(s) proposed by self-heal await a person`
              : result.exitCode === 1
                ? `FAIL: ${result.summary.gatingFindings} gating finding(s)`
                : result.summary.errors > 0
                  ? `ERROR: ${result.summary.errors} item(s) errored${result.budget.exceeded === undefined ? "" : " · budget exceeded"}`
                  : `INCONCLUSIVE: ${result.budget.exceeded ?? "the budget was exceeded before every item ran"}`;
          out?.(`${headline} · ${result.jsonPath}\n`);
          if (result.exitCode === 5) for (const p of result.proposals) out?.(`next: jevitate journey review ${p.journeyId}${p.proposalId === undefined ? "" : ` · jevitate journey promote ${p.journeyId} --proposal ${p.proposalId}`}\n`);
          out?.(result.summary.gatingFindings > 0 ? "next: jevitate report (the findings by fingerprint) · jevitate verify-fix <fp> after a fix\n" : "next: jevitate report\n");
          process.exitCode = result.exitCode;
        }
      } catch (err) {
        if (
          err instanceof SuiteError ||
          err instanceof CheckPreflightError ||
          err instanceof CheckAiSetupError ||
          err instanceof ReportInputError ||
          err instanceof TargetConfigError ||
          err instanceof ApprovalArgsError ||
          err instanceof CheckArgsError ||
          err instanceof ChangesArgsError ||
          err instanceof ChangesInputError
        ) {
          emit(program, fail(err.code, err.message), o.json === true);
        } else if (err instanceof MissingCredentialError || (err instanceof Error && err.name === "GatewaySelectionError")) {
          emit(program, fail("E_AI_SETUP_REQUIRED", err.message), o.json === true);
        } else {
          emit(program, fail("E_CHECK", err instanceof Error ? err.message : String(err)), o.json === true);
        }
      }
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
