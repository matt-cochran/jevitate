/**
 * #585 — `jevitate where`: prints the resolved project layout for the current flags and working
 * directory (docs/contracts/project-layout.md §5) — the project dir, the catalog dir, the Journey
 * store and the logs dir, and where each came from. Paths only; no file contents, no secrets.
 * `--json` prints the `ResolvedLayout` (plus the logs dir); the human form is one line per location.
 * Registered on the root program with `registerWhere` (program.ts wires it in a later change).
 */
import { join } from "node:path";
import type { Command } from "commander";
import { type CliDeps, emitJson } from "./cli-shared.js";
import { ok } from "./envelope.js";
import { EXIT_CODES } from "./exit-codes.js";
import { logsRoot } from "./project-dir.js";
import { journeyLayout } from "./journey-cli/shared.js";
import { withProjectFlags, type ResolvedLayout } from "./project-layout.js";

/** The human form: one line per location, then where the project and Journey store came from. */
function render(data: ResolvedLayout & { readonly logsDir: string }): string {
  const dir = (p: string | null): string => p ?? "(none)";
  return [
    `project   ${dir(data.projectDir)}`,
    `catalog   ${dir(data.catalogDir)}`,
    `journeys  ${data.journeysDir}`,
    `logs      ${data.logsDir}`,
    `from      project: ${data.from.project}, journeys: ${data.from.journeys}`,
    "",
  ].join("\n");
}

/** Registers `jevitate where` (#585 §5): the resolved layout for `--project`/`--journeys-dir` and cwd. */
export function registerWhere(program: Command, deps: CliDeps): void {
  withProjectFlags(program.command("where").description("#585: the resolved project layout — project, catalog, journeys and logs dirs, and where each came from; paths only, no file contents"))
    .option("--json", "emit the ResolvedLayout (plus the logs dir) as a JSON envelope")
    .action(function (this: Command) {
      const { project, journeysDir, json } = this.opts<{ project?: string; journeysDir?: string; json?: boolean }>();
      const layout = journeyLayout(program, deps, { project, journeysDir });
      if (layout === null) return;
      // The logs dir follows an explicit --project (logsRoot() alone discovers only from cwd).
      const logsDir = layout.projectDir === null ? logsRoot() : join(layout.projectDir, "logs");
      const data = { ...layout, logsDir };
      if (json === true) {
        emitJson(program, ok(data));
      } else {
        program.configureOutput().writeOut?.(render(data));
        process.exitCode = EXIT_CODES.ok;
      }
    });
}
