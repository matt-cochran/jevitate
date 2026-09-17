#!/usr/bin/env node
import { join } from "node:path";
import { homedir } from "node:os";
import { ProfileManager } from "@doit/daemon";
import { buildProgram } from "./program.js";

const profiles = new ProfileManager(join(homedir(), ".doit", "profiles"));
const program = buildProgram({ profiles });
program.parseAsync(process.argv).catch((err) => {
  process.stderr.write(`${String(err)}\n`);
  process.exitCode = 1;
});
