import { Command } from "commander";
import { ok, fail } from "./envelope.js";
import { LogsConfigError, loadLogsRetention, pruneLogs } from "./logs-retention.js";
import { logsRoot } from "./project-dir.js";
import { resolveDataDir } from "./data-dir.js";
import { type CliDeps, emitJson } from "./cli-shared.js";

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
}
