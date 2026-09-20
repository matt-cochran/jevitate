#!/usr/bin/env node
import { join } from "node:path";
import { homedir } from "node:os";
import { ProfileManager } from "@jevitate/daemon";
import { buildProgram } from "./program.js";

const profiles = new ProfileManager(join(homedir(), ".doit", "profiles"));
const dbPath = join(homedir(), ".doit", "db.sqlite");
const program = buildProgram({ profiles, dbPath });
program.parseAsync(process.argv).catch((err) => {
  process.stderr.write(`${String(err)}\n`);
  process.exitCode = 1;
});
