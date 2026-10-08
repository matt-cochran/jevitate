import { JEV_PROVIDER_FLAG_HELP, jevProviderArg } from "./cli-shared.js";
import { Command } from "commander";
import { ok, fail } from "./envelope.js";
import { LogsConfigError, loadLogsRetention, pruneLogs } from "./logs-retention.js";
import { logsRoot } from "./project-dir.js";
import { resolveDataDir } from "./data-dir.js";
import { readFileSync } from "node:fs";
import { buildExploreGateways, type CliDeps, emitJson } from "./cli-shared.js";
import { LITERAL_SECRET_WARNING, SecretArgError, resolveSecretArgs } from "./secret-args.js";
import { signalsPathFor, triageRunResult } from "./signal-triage.js";
import { existsSync } from "node:fs";

/** The commands that write run output under `.jevitate/logs` — pruned before, when auto-prune is on. */
const LOG_WRITING_COMMANDS = new Set(["explore", "explore-author-journey", "record", "ux", "check", "run", "verify-fix", "capture"]);

export function registerLogsCommands(program: Command, deps: CliDeps): void {
  const configPath = deps.logs?.configPath ?? resolveDataDir(["config.json"]);
  if (deps.logs?.autoPrune === true) {
    program.hook("preAction", (_root, action) => {
      if (!LOG_WRITING_COMMANDS.has(action.name())) return;
      // A malformed retention config fails closed (the command is refused); a file that cannot be
      // deleted is housekeeping, not the run's business: it is reported and the command goes on.
      const retention = loadLogsRetention(configPath);
      try {
        pruneLogs(deps.logs?.logsRoot ?? logsRoot(), retention);
      } catch (e) {
        process.stderr.write(`warning: log pruning skipped: ${e instanceof Error ? e.message : String(e)}\n`);
      }
    });
  }
  const logs = program.command("logs").description("run output under .jevitate/logs (dated; pruned by retention)");
  logs
    .command("prune")
    .description("delete runs older than the retention TTL, always keeping the newest runs (config.json logs.ttlDays / logs.keepLatest; defaults 14 and 50)")
    .option("--dir <dir>", "logs root to prune (default: the project's .jevitate/logs, else ~/.jevitate/logs)")
    .option("--dry-run", "list what would be deleted, deleting nothing")
    .option("--json", "emit a JSON envelope")
    .action(function (this: Command) {
      const o = this.opts<{ dir?: string; dryRun?: boolean; json?: boolean }>();
      try {
        const retention = loadLogsRetention(configPath);
        const report = pruneLogs(o.dir ?? deps.logs?.logsRoot ?? logsRoot(), retention, { ...(o.dryRun === true ? { dryRun: true } : {}) });
        const data = { ...report, retention, dryRun: o.dryRun === true };
        if (o.json === true) emitJson(program, ok(data));
        else program.configureOutput().writeOut?.(`${o.dryRun === true ? "would remove" : "removed"} ${report.removed.length} run(s); kept ${report.keptRuns} (ttl ${retention.ttlDays}d, keep latest ${retention.keepLatest})\n`);
      } catch (err) {
        if (err instanceof LogsConfigError) emitJson(program, fail(err.code, err.message));
        else emitJson(program, fail("E_LOGS_PRUNE", err instanceof Error ? err.message : String(err)));
      }
    });

  logs
    .command("triage")
    .description(
      "#313: re-triage a finished run's signals (<run>.signals.jsonl, written by explore --log-triage): attach to each defect only the lines that relate to it " +
        "(defects[].relatedLogs) — the lines correlated to its request, then, with --real, the window lines Jev scores relevant (else its error/warning lines). Rewrites the result",
    )
    .requiredOption("--result <path>", "the run's <run>.result.json (its <run>.signals.jsonl must sit next to it)")
    .option("--secret <value|env:VAR>", "a value to keep out of the judgment payload (repeatable; env:VAR reads it from the environment)", (v: string, prev: string[]) => [...prev, v], [] as string[])
    .option("--threshold <p>", "Jev relevance probability at or above which a line is kept (default 0.5)", (v: string) => Number(v))
    .option("--real", "score relevance with the live Jev gateway (requires keys; log text goes to the judgment model, redacted)", false)
    .option("--fake-ai", "no model: keep the correlated lines and the window's error/warning lines (code only)", false)
    .option("--jev-provider <provider>", JEV_PROVIDER_FLAG_HELP, jevProviderArg)
    .option("--json", "emit a JSON envelope")
    .action(async function (this: Command) {
      const o = this.opts<{ result: string; secret: string[]; threshold?: number; real?: boolean; fakeAi?: boolean;
        jevProvider?: string; json?: boolean }>();
      const emit = (envelope: Parameters<typeof emitJson>[1]): void => emitJson(program, envelope);
      if (o.real === true && o.fakeAi === true) return emit(fail("E_LOGS_ARGS", "--real and --fake-ai are mutually exclusive — pass one, not both"));
      if (o.threshold !== undefined && !(o.threshold >= 0 && o.threshold <= 1)) return emit(fail("E_LOGS_ARGS", "--threshold must be a probability in 0..1"));
      if (!existsSync(signalsPathFor(o.result))) {
        return emit(fail("E_LOGS_ARGS", `no signals next to ${o.result} (${signalsPathFor(o.result)}): run explore with --log-source and --log-triage first`));
      }
      let secrets: string[];
      try {
        const resolved = resolveSecretArgs(o.secret, process.env, "--secret");
        if (resolved.literals > 0) program.configureOutput().writeErr?.(LITERAL_SECRET_WARNING);
        secrets = resolved.secrets;
      } catch (err) {
        if (err instanceof SecretArgError) return emit(fail("E_LOGS_ARGS", err.message));
        throw err;
      }
      try {
        const file = JSON.parse(readFileSync(o.result, "utf8")) as { result?: Record<string, unknown> };
        if (typeof file.result !== "object" || file.result === null) return emit(fail("E_LOGS_ARGS", `${o.result} is not a jevitate run result`));
        const judge = o.real === true ? (await buildExploreGateways(deps, { real: true, fakeAi: false, jevProvider: o.jevProvider })).judge : undefined;
        const updated = await triageRunResult(file.result, o.result, {
          secrets,
          ...(judge === undefined ? {} : { judge }),
          ...(o.threshold === undefined ? {} : { threshold: o.threshold }),
        });
        const defects = (Array.isArray(updated.defects) ? updated.defects : []) as Array<{ fingerprint?: string; relatedLogs?: unknown[] }>;
        const data = { resultPath: o.result, signals: updated.signals, defects: defects.map((d) => ({ fingerprint: d.fingerprint, relatedLogs: d.relatedLogs ?? [] })) };
        if (o.json === true) emit(ok(data));
        else {
          const s = updated.signals as { entries: number; triage: { mode: string; kept: number; candidates: number; jevCalls: number } };
          program.configureOutput().writeOut?.(`triaged ${defects.length} defect(s) over ${s.entries} signal(s) (${s.triage.mode}): kept ${s.triage.kept} of ${s.triage.candidates} candidate line(s), ${s.triage.jevCalls} Jev call(s)\nresult   ${o.result}\n`);
        }
      } catch (err) {
        emit(fail("E_LOGS_TRIAGE", err instanceof Error ? err.message : String(err)));
      }
    });
}
