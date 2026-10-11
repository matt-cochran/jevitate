import { writeFile } from "node:fs/promises";
import { Command } from "commander";
import { ok, fail } from "../envelope.js";
import { lintJourneyById, UnknownJourneyError } from "../journey-api.js";
import { resolveCatalogDir } from "../catalog-api.js";
import { anchorEditFailure } from "../journey-anchor-cli.js";
import { fixJourneyAnchors } from "../journey-anchor-api.js";
import { currentEngineInfo } from "../engine.js";
import { renderJourneyLintSarif } from "../journey-lint-sarif.js";
import { type CliDeps, resolveJourneysDir, emitJson } from "../cli-shared.js";
import { lintFindingLine } from "./shared.js";

/** Registers `jevitate journey lint`. */
export function registerJourneyLint(journey: Command, program: Command, deps: CliDeps): void {
  // #401 — the assertion-strength lint: which assertions cannot prove the Journey's outcome. CI can
  // gate on it (`--json`/`--sarif`, exit 1 when any error); `promote` runs the same lint first.
  journey
    .command("lint <id>")
    .description("report a Journey's weak assertions (writes without an asserted effect, visibility-only claims, nothing after the last write, …)")
    .option("--dir <path>", "journeys directory (default: the repo's .jevitate/journeys; outside a repo ~/.jevitate/journeys)")
    .option("--sarif <file>", "also write a SARIF 2.1.0 log here")
    .option("--fix", "#487: stamp the step id of each anchor that references a step by number only, write the Journey (a draft; a promoted one is refused), and report what was fixed")
    .option("--json", "emit a JSON envelope")
    .action(async function (this: Command, id: string) {
      const { dir, json, sarif, fix } = this.opts<{ dir?: string; json?: boolean; sarif?: string; fix?: boolean }>();
      try {
        let fixed: Awaited<ReturnType<typeof fixJourneyAnchors>>["stamped"] = [];
        if (fix === true) {
          try {
            fixed = (await fixJourneyAnchors(resolveJourneysDir(deps, dir), id)).stamped;
          } catch (err) {
            if (err instanceof UnknownJourneyError) throw err;
            anchorEditFailure(program, err);
            return;
          }
        }
        const result = await lintJourneyById(resolveJourneysDir(deps, dir), id, { catalogDir: resolveCatalogDir(deps.catalogDir) });
        if (sarif !== undefined) {
          const log = renderJourneyLintSarif({ id: result.id, findings: result.findings, version: currentEngineInfo().version });
          await writeFile(sarif, `${JSON.stringify(log, null, 2)}\n`);
        }
        if (json) {
          emitJson(program, ok({ id: result.id, findings: result.findings, errors: result.errors, warnings: result.warnings, ...(fix === true ? { fixed } : {}) }));
        } else {
          const out = program.configureOutput().writeOut;
          if (fix === true) {
            for (const a of fixed) out?.(`fixed: anchor '${a.name}' now carries stepId '${a.stepId}' (step ${a.step})\n`);
            if (fixed.length === 0) out?.("fixed: nothing — no anchor references a step by number only\n");
          }
          for (const finding of result.findings) out?.(`${lintFindingLine(finding)}\n`);
          out?.(`${result.errors} error(s), ${result.warnings} warning(s) — journey '${result.id}'\n`);
        }
        process.exitCode = result.errors > 0 ? 1 : 0;
      } catch (err) {
        if (err instanceof UnknownJourneyError) {
          emitJson(program, fail("E_UNKNOWN_JOURNEY", String(err.message)));
        } else {
          emitJson(program, fail("E_JOURNEY_LINT_ARGS", String(err instanceof Error ? err.message : err)));
        }
      }
    });
}
