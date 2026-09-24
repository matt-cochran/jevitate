#!/usr/bin/env node
import { ProfileManager } from "@jevitate/daemon";
import { buildProgram } from "./program.js";
import { resolveDataDir } from "./data-dir.js";
import { installMissionKillSwitch } from "./kill-signal.js";

// Crash-safe SIGTERM/SIGINT (#94): installed FIRST, before anything else — in particular before any
// browser can have launched. Playwright installs its own SIGTERM/SIGINT handler on a browser it
// launches, and Node invokes same-signal listeners in registration order, so this must be the
// EARLIEST listener to guarantee its (synchronous) write-then-exit always runs before Playwright's
// handler can tear the browser down and let an in-flight mission's own completion race it to
// `process.exit` with an unrelated result/code. See kill-signal.ts.
installMissionKillSwitch();

// `~/.jevitate/*` is the product's runtime-data convention. See data-dir.ts.
const profiles = new ProfileManager(resolveDataDir(["profiles"]));
const dbPath = resolveDataDir(["db.sqlite"]);
const program = buildProgram({ profiles, dbPath });
program.parseAsync(process.argv).catch((err) => {
  process.stderr.write(`${String(err)}\n`);
  process.exitCode = 1;
});
