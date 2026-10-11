import { type Command } from "commander";
import type { CliDeps } from "./cli-shared.js";
import { registerExploreRun } from "./explore-cli/run.js";

/**
 * Registers `jevitate explore` (every strategy: goal, coverage, exploratory, adversarial, usability, feature, multi-run).
 * `buildProgram` builds a fresh program for each run of a multi-run (#141/#143).
 */
export function registerExploreCommands(program: Command, deps: CliDeps, buildProgram: (deps: CliDeps) => Command): void {
  registerExploreRun(program, deps, buildProgram);
}
