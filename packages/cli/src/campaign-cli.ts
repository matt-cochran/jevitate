import type { Command } from "commander";
import { ok, fail } from "./envelope.js";
import { withEngine } from "./engine.js";
import { CampaignSpecError, runCampaign, validateCampaign, type CampaignResult } from "./campaign-api.js";
import { type CliDeps, emitCommandResult, environmentSeams, resolveJourneysDir, resolveMissionTargetsDir, withScreenshotsFlag } from "./cli-shared.js";
import { nonNegativeIntArg, positiveIntArg } from "./cli-args.js";
import { forwardedArgv } from "./multi-run-cli.js";

/** `campaign run`'s own options: everything else it declares is forwarded to every mission (#311). */
const CAMPAIGN_OWNED: ReadonlySet<string> = new Set(["journeysDir", "out", "allowShellHooks", "hookTimeoutMs", "real", "fakeAi", "json"]);

const collect = (v: string, prev: string[]): string[] => [...prev, v];

/** The flags every anchored mission of this `campaign run` is re-invoked with (#311). */
export function campaignMissionArgv(cmd: Command): string[] {
  return forwardedArgv(cmd, CAMPAIGN_OWNED);
}

/**
 * #311: the `explore` options a campaign forwards to every anchored mission, as given — safety
 * (destructive/paid/deny), invariants, backend-log evidence and media. Operator flags only: the
 * spec file never widens what a mission may click or read.
 */
function withMissionFlags(cmd: Command): Command {
  const each = "(forwarded to every mission, as explore's)";
  const repeatable: ReadonlyArray<readonly [string, string]> = [
    ["--deny <pattern>", "a control no mission may click (repeatable)"],
    ["--paid <pattern>", "an app control that costs money or credits (repeatable)"],
    ["--allow-control <regex>", "exempt a control whose name matches from the soft 'may cost money' heuristic only (repeatable, #428)"],
    ["--invariants <file>", "app-declared invariants JSON (repeatable)"],
    ["--log-source <spec>", "backend log source: file:<path> | docker:<container> | cmd:<command> (needs --allow-log-cmd) (repeatable)"],
    ["--log-defect <level|/regex/>", "backend log lines matching this become a server-log defect (repeatable)"],
    ["--log-quiet-ok <spec>", "a --log-source that is legitimately quiet (repeatable)"],
    ["--log-ignore <regex|substring>", "known-noise backend log lines to exclude (repeatable)"],
    ["--log-scope <regex|substring>", "attribute only backend log lines matching this (repeatable)"],
    ["--log-correlation-header <name>", "another header carrying a correlation id (repeatable)"],
    ["--log-id-pattern </regex/>", "how a correlation id is written in log lines (repeatable)"],
  ];
  for (const [flags, desc] of repeatable) cmd.option(flags, `${desc} ${each}`, collect, [] as string[]);
  cmd
    .option("--allow-destructive", `let missions click session-ending, destructive and paid controls (a --deny pattern still holds) ${each}`)
    .option("--allow-writes", `let a find-out mission change the app ${each}`)
    .option("--allow-log-cmd", `a --log-source cmd:<command> may run as a subprocess ${each}`)
    .option("--log-triage", `record each mission's signal timeline and attach only the related lines to each defect (#313) ${each}`)
    .option("--server-log-drain-ms <ms>", `how long to keep tailing --log-source after a mission's last action (default 3000) ${each}`, nonNegativeIntArg)
    .option("--evidence-video", `per defect: a captioned repro clip and before/at screenshots ${each}`)
    .option("--record-video [dir]", `record a video of each mission's browser context ${each}`);
  return withScreenshotsFlag(cmd);
}

/** `campaign run`'s human summary: the outcome, every mission's branch point, and the deduped defects. */
export function formatCampaignHuman(data: unknown): string {
  const r = data as CampaignResult;
  const lines = [
    `CAMPAIGN ${r.name ?? ""}`.trimEnd(),
    `outcome  ${r.missionOutcome} (exit ${r.exitCode}) · ${r.missions.length} mission(s) · ${r.report.summary.defects} deduped defect(s), ${r.report.summary.advisory} advisory`,
    ...r.discovery.filter((d) => d.outcome !== "ok").map((d) => `STALE    job ${d.job}: journey ${d.journeyId} — ${d.reason ?? d.outcome} (its missions were skipped)`),
    ...r.missions.map(
      (m) =>
        `${m.status === "ran" ? "RAN" : m.status.toUpperCase()}`.padEnd(9) +
        `${m.job} · ${m.branch.journeyId} step ${m.branch.step}${m.branch.anchor === undefined ? "" : ` (${m.branch.anchor})`} · ${m.strategy} → ${m.missionOutcome}${m.failure === undefined ? "" : ` (${m.failure.kind})`}`,
    ),
    ...r.report.defects.map((d) => `DEFECT   ${d.title} · ${d.runCount} run(s)${d.branches === undefined ? "" : ` · from ${d.branches.map((b) => `${b.journeyId}@${b.anchor ?? b.step}`).join(", ")}`}`),
    `report   ${r.reportPath}`,
    `result   ${r.resultPath}`,
  ];
  return `${lines.join("\n")}\n`;
}

/** Registers `jevitate campaign run <spec.json>` (#293). */
export function registerCampaignCommands(program: Command, deps: CliDeps, buildProgram: (deps: CliDeps) => Command): void {
  const campaign = program.command("campaign").description("journey-anchored test campaigns (#293): many anchored missions, one deduped report");
  withMissionFlags(campaign
    .command("run <spec>"))
    .description(
      "run a campaign spec (JSON): replay each job's promoted Journey (discovery), then run its anchored missions in order — " +
        "explore --from-journey <journey> --at-step <anchor> --strategy <s> — with the spec's --fixtures restore around every run, " +
        "and write ONE deduped report (campaign.json + campaign.md). An invalid spec is refused with every problem listed (exit 64)",
    )
    .option("--journeys-dir <path>", "journeys directory (default: the repo's .jevitate/journeys; outside a repo ~/.jevitate/journeys)")
    .option("--out <dir>", "the campaign's directory: every mission's results, campaign.json and campaign.md (default .jevitate/logs/<date>/campaign-<stamp>)")
    .option("--allow-shell-hooks", "opt in to running the spec's before/after operator hooks around every run (never model-chosen)", false)
    .option("--hook-timeout-ms <ms>", "timeout for each of the spec's before/after hooks (default 60000; the process group is killed)", positiveIntArg)
    .option("--real", "use live Jev + OpenRouter gateways for the missions (requires keys)", false)
    .option("--fake-ai", "use deterministic fake gateways (pipeline smoke only)", false)
    .option("--json", "emit the JSON envelope (default: a human summary)")
    .action(async function (this: Command, spec: string) {
      const o = this.opts<{ journeysDir?: string; out?: string; allowShellHooks?: boolean; hookTimeoutMs?: number; real?: boolean; fakeAi?: boolean; json?: boolean }>();
      const emit = (envelope: Parameters<typeof emitCommandResult>[1], exitCode?: number): void =>
        emitCommandResult(program, envelope, { json: o.json === true, command: "campaign run", human: formatCampaignHuman, ...(exitCode === undefined ? {} : { exitCode }) });
      if (o.real !== true && o.fakeAi !== true) {
        emit(fail("E_CAMPAIGN_ARGS", "a campaign's missions are model-driven: pass --real (live gateways) or --fake-ai (pipeline smoke only)"));
        return;
      }
      const journeysDir = resolveJourneysDir(deps, o.journeysDir);
      try {
        const plan = await validateCampaign(spec, {
          journeysDir,
          allowShellHooks: o.allowShellHooks === true,
          ...(o.hookTimeoutMs === undefined ? {} : { hookTimeoutMs: o.hookTimeoutMs }),
          environmentSeams: environmentSeams(deps),
        });
        const result = await runCampaign(plan, {
          newProgram: () => buildProgram(deps),
          journeysDir,
          missionTargetsDir: resolveMissionTargetsDir(deps),
          ...(o.out === undefined ? {} : { outDir: o.out }),
          ...(o.real === true ? { real: true } : {}),
          ...(o.fakeAi === true ? { fakeAi: true } : {}),
          missionArgs: campaignMissionArgv(this),
        });
        emit(ok(withEngine(result)), result.exitCode);
      } catch (err) {
        if (err instanceof CampaignSpecError) emit(fail(err.code, err.message));
        else emit(fail("E_CAMPAIGN_RUN", String(err instanceof Error ? err.message : err)));
      }
    });
}
