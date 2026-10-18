import type { Command } from "commander";
import { ok, fail } from "./envelope.js";
import { UnknownJourneyError } from "./journey-api.js";
import { CatalogInputError } from "./catalog.js";
import { catalogLayout, DEPRECATED_PROJECT_DIR_HELP } from "./catalog-api.js";
import { JourneyLinkArgsError, linkJourney, type JourneyLinkResult } from "./journey-link-api.js";
import { type CliDeps, emitJson } from "./cli-shared.js";
import { withProjectFlags } from "./project-layout.js";

function renderLink(r: JourneyLinkResult, out: ((s: string) => void) | undefined): void {
  const job = r.job === undefined ? "no job" : `job '${r.job}'${r.jobStatus === undefined ? "" : ` (${r.jobStatus})`}`;
  const persona = r.persona === undefined ? "no persona" : `persona '${r.persona}'${r.personaStatus === undefined ? "" : ` (${r.personaStatus})`}`;
  out?.(`${r.changed ? "linked" : "unchanged:"} journey '${r.journeyId}' → ${job}, ${persona}\n`);
  for (const note of r.needsApproval) out?.(`  needs approval: ${note}\n`);
  if (r.needsReapproval) {
    out?.(`journey '${r.journeyId}' is promoted: its approval is now stale (kept for the review diff; \`journey review --stale\` lists it, \`check --require-approvals\` fails it)\n`);
    out?.(`re-approve after review: ${r.reapproveCommand}\n`);
  }
}

/**
 * #523 — `jevitate journey link <id> [--job <jobId>] [--persona <personaId>] [--unlink-job] [--unlink-persona]`:
 * set or clear a Journey's catalog links, each id checked against the catalog. Never an approval.
 */
export function registerJourneyLinkCommand(journey: Command, program: Command, deps: CliDeps): void {
  withProjectFlags(
    journey
      .command("link <id>")
      .description(
        "#523: link a Journey to a catalog job and/or persona (metadata.job / metadata.persona), or clear a link — an id the catalog does not have is refused (listing its ids); a draft entry may be linked and still needs a person's approval; on a promoted Journey the approval goes stale (#507). Never approves",
      )
      .option("--job <jobId>", "link this job (an id in the project's jobs.json)")
      .option("--persona <personaId>", "link this persona (an id in the project's personas.json)")
      .option("--unlink-job", "clear metadata.job")
      .option("--unlink-persona", "clear metadata.persona")
      .option("--dir <path>", DEPRECATED_PROJECT_DIR_HELP),
  )
    .option("--json", "emit a JSON envelope")
    .action(async function (this: Command, id: string) {
      const { job, persona, unlinkJob, unlinkPersona, dir, project, journeysDir, json } = this.opts<{ job?: string; persona?: string; unlinkJob?: boolean; unlinkPersona?: boolean; dir?: string; project?: string; journeysDir?: string; json?: boolean }>();
      // Linking validates ids against the catalog, so it needs a project; clearing a link alone does not.
      const layout = catalogLayout(program, deps, { dir, project, journeysDir }, { requireProject: job !== undefined || persona !== undefined });
      if (layout === null) return;
      try {
        const result = await linkJourney(layout.journeysDir, layout.catalogDir, id, {
          ...(job === undefined ? {} : { job }),
          ...(persona === undefined ? {} : { persona }),
          ...(unlinkJob === true ? { unlinkJob } : {}),
          ...(unlinkPersona === true ? { unlinkPersona } : {}),
        });
        if (json) emitJson(program, ok(result));
        else {
          renderLink(result, program.configureOutput().writeOut);
          process.exitCode = 0;
        }
      } catch (err) {
        if (err instanceof UnknownJourneyError) emitJson(program, fail("E_UNKNOWN_JOURNEY", err.message));
        else if (err instanceof JourneyLinkArgsError || err instanceof CatalogInputError) emitJson(program, fail(err.code, err.message));
        else emitJson(program, fail("E_JOURNEY_LINK_ARGS", String(err instanceof Error ? err.message : err)));
      }
    });
}
