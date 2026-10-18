import { Command } from "commander";
import { FsJourneyStore, JourneyRegistry, journeyStepCount, listJourneyAnchors } from "@jevitate/journey";
import { ok, fail } from "../envelope.js";
import { runAnchorSuggest } from "../journey-anchor-cli.js";
import { type CliDeps, emitJson } from "../cli-shared.js";
import { withProjectFlags } from "../project-layout.js";
import { DEPRECATED_DIR_HELP, journeyLayout } from "./shared.js";

/** Registers `jevitate journey anchors`. */
export function registerJourneyAnchors(journey: Command, program: Command, deps: CliDeps): void {
  // #293 — the named states worth exploring from (`explore --from-journey <id> --at-step <name>`).
  withProjectFlags(journey
    .command("anchors <id>")
    .description("list a Journey's anchors (#293): named steps to branch a mission off with `explore --from-journey <id> --at-step <name>`, and their suggested probes")
    .option("--suggest", "propose anchors where the recorded flow changes state (a new page, a form that became valid, a completed write), each with the `journey anchor add` command to accept it; advisory, writes nothing (#487)")
    .option("--dir <path>", DEPRECATED_DIR_HELP))
    .option("--json", "emit a JSON envelope")
    .action(async function (this: Command, id: string) {
      const { dir, project, journeysDir, json, suggest } = this.opts<{ dir?: string; project?: string; journeysDir?: string; json?: boolean; suggest?: boolean }>();
      const layout = journeyLayout(program, deps, { dir, project, journeysDir });
      if (layout === null) return;
      if (suggest) {
        await runAnchorSuggest(program, deps, id, { dir: layout.journeysDir, json });
        return;
      }
      try {
        const found = await new JourneyRegistry(new FsJourneyStore(layout.journeysDir)).get(id);
        if (found === null) {
          emitJson(program, fail("E_UNKNOWN_JOURNEY", `unknown journey '${id}'`));
          return;
        }
        const data = { journeyId: found.metadata.id, promoted: found.metadata.promoted, steps: journeyStepCount(found), anchors: listJourneyAnchors(found) };
        if (json) {
          emitJson(program, ok(data));
        } else {
          const out = program.configureOutput().writeOut;
          if (data.anchors.length === 0) {
            out?.(`journey '${data.journeyId}' declares no anchors — branch off a step number instead (--at-step 1..${data.steps}), or add metadata.anchors\n`);
          }
          for (const a of data.anchors) {
            out?.(`${a.name}\tstep ${a.step}\tafter: ${a.afterStep}${a.description === undefined ? "" : `\t${a.description}`}${a.probes.length === 0 ? "" : `\tprobes: ${a.probes.join("; ")}`}\n`);
          }
          if (!data.promoted) out?.(`note: journey '${data.journeyId}' is not promoted — missions branch only off promoted Journeys\n`);
          process.exitCode = 0;
        }
      } catch (err) {
        emitJson(program, fail("E_JOURNEY_ANCHORS_ARGS", String(err instanceof Error ? err.message : err)));
      }
    });
}
