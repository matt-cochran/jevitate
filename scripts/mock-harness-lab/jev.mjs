#!/usr/bin/env node
// Lab launcher: the worktree's built CLI (packages/cli/dist/bin.js) PLUS `registerDoneCheckHooks()`.
//
// Finding (#802 lab, 2026-11-09): at e71fb65e nothing in the shipped CLI calls
// `registerDoneCheckHooks()` (only tests do), so `jevitate journey run` never reads the job's done
// check and never returns `job` at all — on a harness or anywhere else. This launcher adds the one
// call so the experiment can measure what #800/#802 specify. `--plain` runs bin.js unchanged.
import { ProfileManager } from "../../packages/daemon/dist/index.js";
import { buildProgram } from "../../packages/cli/dist/program.js";
import { resolveDataDir } from "../../packages/cli/dist/data-dir.js";
import { installMissionKillSwitch } from "../../packages/cli/dist/kill-signal.js";
import { EXIT_CODES } from "../../packages/cli/dist/exit-codes.js";
import { installBrokenPipePolicy, reportCommandRejection } from "../../packages/cli/dist/terminal-result.js";
import { registerDoneCheckHooks } from "../../packages/cli/dist/journey-done-check-hook.js";

installBrokenPipePolicy();
installMissionKillSwitch();
registerDoneCheckHooks();
const program = buildProgram({ profiles: new ProfileManager(resolveDataDir(["profiles"])), dbPath: resolveDataDir(["db.sqlite"]), logs: { autoPrune: false } });
program.parseAsync(process.argv).catch((err) => {
  if (reportCommandRejection(err)) return;
  process.stderr.write(`${String(err)}\n`);
  process.exitCode = EXIT_CODES.inconclusive;
});
