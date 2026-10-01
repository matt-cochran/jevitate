import type { Command } from "commander";
import { ok, fail } from "./envelope.js";
import { withEngine } from "./engine.js";
import { CampaignSpecError, runCampaign, validateCampaign, type CampaignResult } from "./campaign-api.js";
import { type CliDeps, emitCommandResult, environmentSeams, resolveJourneysDir, resolveMissionTargetsDir } from "./cli-shared.js";

/** `campaign run`'s human summary: the outcome, every mission's branch point, and the deduped defects. */
function formatCampaignHuman(data: unknown): string {
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
  campaign
    .command("run <spec>")
    .description(
      "run a campaign spec (JSON): replay each job's promoted Journey (discovery), then run its anchored missions in order — " +
        "explore --from-journey <journey> --at-step <anchor> --strategy <s> — with the spec's --fixtures restore around every run, " +
        "and write ONE deduped report (campaign.json + campaign.md). An invalid spec is refused with every problem listed (exit 64)",
    )
    .option("--journeys-dir <path>", "journeys directory (default: the repo's .jevitate/journeys; outside a repo ~/.jevitate/journeys)")
    .option("--out <dir>", "the campaign's directory: every mission's results, campaign.json and campaign.md (default .jevitate/logs/<date>/campaign-<stamp>)")
    .option("--allow-shell-hooks", "opt in to running the spec's before/after operator hooks around every run (never model-chosen)", false)
    .option("--real", "use live Jev + OpenRouter gateways for the missions (requires keys)", false)
    .option("--fake-ai", "use deterministic fake gateways (pipeline smoke only)", false)
    .option("--json", "emit the JSON envelope (default: a human summary)")
    .action(async function (this: Command, spec: string) {
      const o = this.opts<{ journeysDir?: string; out?: string; allowShellHooks?: boolean; real?: boolean; fakeAi?: boolean; json?: boolean }>();
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
          environmentSeams: environmentSeams(deps),
        });
        const result = await runCampaign(plan, {
          newProgram: () => buildProgram(deps),
          journeysDir,
          missionTargetsDir: resolveMissionTargetsDir(deps),
          ...(o.out === undefined ? {} : { outDir: o.out }),
          ...(o.real === true ? { real: true } : {}),
          ...(o.fakeAi === true ? { fakeAi: true } : {}),
        });
        emit(ok(withEngine(result)), result.exitCode);
      } catch (err) {
        if (err instanceof CampaignSpecError) emit(fail(err.code, err.message));
        else emit(fail("E_CAMPAIGN_RUN", String(err instanceof Error ? err.message : err)));
      }
    });
}
