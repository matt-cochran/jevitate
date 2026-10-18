import { writeFile } from "node:fs/promises";
import { Command } from "commander";
import { ok, fail } from "../envelope.js";
import { lintJourneyById, UnknownJourneyError } from "../journey-api.js";
import { resolveCatalogDir } from "../catalog-api.js";
import { anchorEditFailure } from "../journey-anchor-cli.js";
import { fixJourneyAnchors } from "../journey-anchor-api.js";
import { currentEngineInfo } from "../engine.js";
import { renderJourneyLintSarif } from "../journey-lint-sarif.js";
import { type CliDeps, emitJson } from "../cli-shared.js";
import { withProjectFlags } from "../project-layout.js";
import { DEPRECATED_DIR_HELP, flaggedCatalogDir, journeyLayout, lintFindingLine } from "./shared.js";
import { FsJourneyStore } from "@jevitate/journey";
import { journeyLinkWarnings } from "../journey-link-hints.js";

/** Registers `jevitate journey lint`. */
export function registerJourneyLint(journey: Command, program: Command, deps: CliDeps): void {
  // #401 — the assertion-strength lint: which assertions cannot prove the Journey's outcome. CI can
  // gate on it (`--json`/`--sarif`, exit 1 when any error); `promote` runs the same lint first.
  withProjectFlags(journey
    .command("lint <id>")
    .description("report a Journey's weak assertions (writes without an asserted effect, visibility-only claims, nothing after the last write, …)")
    .option("--dir <path>", DEPRECATED_DIR_HELP))
    .option("--sarif <file>", "also write a SARIF 2.1.0 log here")
    .option("--fix", "#487: stamp the step id of each anchor that references a step by number only, write the Journey (#507: on a promoted Journey its approval goes stale), and report what was fixed")
    .option("--json", "emit a JSON envelope")
    .action(async function (this: Command, id: string) {
      const { dir, project, journeysDir, json, sarif, fix } = this.opts<{ dir?: string; project?: string; journeysDir?: string; json?: boolean; sarif?: string; fix?: boolean }>();
      const layout = journeyLayout(program, deps, { dir, project, journeysDir });
      if (layout === null) return;
      const resolvedJourneysDir = layout.journeysDir;
      try {
        let fixResult: Awaited<ReturnType<typeof fixJourneyAnchors>> | undefined;
        if (fix === true) {
          try {
            fixResult = await fixJourneyAnchors(resolvedJourneysDir, id);
          } catch (err) {
            if (err instanceof UnknownJourneyError) throw err;
            anchorEditFailure(program, err);
            return;
          }
        }
        const fixed = fixResult?.stamped ?? [];
        // #507: stamping a promoted Journey makes its approval stale — say so, with the re-approval command.
        const reapproval = fixResult?.needsReapproval === true ? { needsReapproval: true as const, reapproveCommand: fixResult.reapproveCommand } : {};
        const catalogDir = resolveCatalogDir(deps.catalogDir, flaggedCatalogDir(layout));
        const linted = await lintJourneyById(resolvedJourneysDir, id, { catalogDir });
        // #523: catalog-aware, advisory: a missing job / persona link is a warning with its fix.
        const stored = await new FsJourneyStore(resolvedJourneysDir).get(id);
        const linkFindings = stored === null ? [] : await journeyLinkWarnings(catalogDir, stored);
        const result = { ...linted, findings: [...linted.findings, ...linkFindings], warnings: linted.warnings + linkFindings.length };
        if (sarif !== undefined) {
          const log = renderJourneyLintSarif({ id: result.id, findings: result.findings, version: currentEngineInfo().version });
          await writeFile(sarif, `${JSON.stringify(log, null, 2)}\n`);
        }
        if (json) {
          emitJson(program, ok({ id: result.id, findings: result.findings, errors: result.errors, warnings: result.warnings, ...(fix === true ? { fixed, ...reapproval } : {}) }));
        } else {
          const out = program.configureOutput().writeOut;
          if (fix === true) {
            for (const a of fixed) out?.(`fixed: anchor '${a.name}' now carries stepId '${a.stepId}' (step ${a.step})\n`);
            if (fixed.length === 0) out?.("fixed: nothing — no anchor references a step by number only\n");
            if (fixResult?.needsReapproval === true) {
              out?.(`journey '${id}' is promoted: its approval is now stale (kept for the review diff; \`journey review --stale\` lists it, \`check --require-approvals\` fails it)\n`);
              out?.(`re-approve after review: ${fixResult.reapproveCommand}\n`);
            }
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
