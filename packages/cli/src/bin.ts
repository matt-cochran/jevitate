#!/usr/bin/env node
import { ProfileManager } from "@jevitate/daemon";
import { buildProgram } from "./program.js";
import { resolveDataDir } from "./data-dir.js";

// D8: `~/.jevitate/*` is the current product convention; `resolveDataDir`
// falls back to a pre-existing `~/.doit/*` path so a pre-rename user's local
// data isn't orphaned. See data-dir.ts.
const profiles = new ProfileManager(resolveDataDir(["profiles"]));
const dbPath = resolveDataDir(["db.sqlite"]);
const program = buildProgram({ profiles, dbPath });
program.parseAsync(process.argv).catch((err) => {
  process.stderr.write(`${String(err)}\n`);
  process.exitCode = 1;
});
