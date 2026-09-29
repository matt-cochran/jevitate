#!/usr/bin/env node
import { ProfileManager } from "@jevitate/daemon";
import { buildProgram } from "./program.js";
import { resolveDataDir } from "./data-dir.js";
import { installMissionKillSwitch } from "./kill-signal.js";
import { EXIT_CODES } from "./exit-codes.js";
import { runtimeEnvProblems } from "./runtime-env.js";

// #213: `jevitate <cmd> | head -1` (or any reader that closes early) makes the next stdout/stderr
// write fail EPIPE. Node has no default SIGPIPE handling and turns that into an uncaught exception
// — a stack trace and a nonzero crash for a perfectly normal pipeline. Every command exits quietly
// (0: the command's own output was never the failure) instead.
for (const stream of [process.stdout, process.stderr]) {
  stream.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EPIPE") process.exit(0);
    throw err;
  });
}

// Crash-safe SIGTERM/SIGINT (#94): installed FIRST, before anything else — in particular before any
// browser can have launched. Playwright installs its own SIGTERM/SIGINT handler on a browser it
// launches, and Node invokes same-signal listeners in registration order, so this must be the
// EARLIEST listener to guarantee its (synchronous) write-then-exit always runs before Playwright's
// handler can tear the browser down and let an in-flight mission's own completion race it to
// `process.exit` with an unrelated result/code. See kill-signal.ts.
installMissionKillSwitch();

// #213: numeric JEVITATE_* tuning variables are checked once, up front — a typo is a usage error
// (exit 64) before any browser opens, never a mid-run crash or a silent fall back to the default.
const envProblems = runtimeEnvProblems();
if (envProblems.length > 0) {
  for (const p of envProblems) process.stderr.write(`error E_CLI_ENV: ${p}\n`);
  process.exit(EXIT_CODES.usage);
}

// `~/.jevitate/*` is the product's runtime-data convention. See data-dir.ts.
const profiles = new ProfileManager(resolveDataDir(["profiles"]));
const dbPath = resolveDataDir(["db.sqlite"]);
const program = buildProgram({ profiles, dbPath, logs: { autoPrune: true } });
program.parseAsync(process.argv).catch((err) => {
  process.stderr.write(`${String(err)}\n`);
  // An unexpected error: the command could not finish, so it proves nothing (exit-codes.ts).
  process.exitCode = EXIT_CODES.inconclusive;
});
