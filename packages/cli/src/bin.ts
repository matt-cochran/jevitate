#!/usr/bin/env node
import { ProfileManager } from "@jevitate/daemon";
import { buildProgram } from "./program.js";
import { resolveDataDir } from "./data-dir.js";

// `~/.jevitate/*` is the product's runtime-data convention. See data-dir.ts.
const profiles = new ProfileManager(resolveDataDir(["profiles"]));
const dbPath = resolveDataDir(["db.sqlite"]);
const program = buildProgram({ profiles, dbPath });
program.parseAsync(process.argv).catch((err) => {
  process.stderr.write(`${String(err)}\n`);
  process.exitCode = 1;
});
