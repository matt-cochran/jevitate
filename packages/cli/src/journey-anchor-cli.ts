import type { Command } from "commander";
import { ok, fail } from "./envelope.js";
import { UnknownJourneyError } from "./journey-api.js";
import { AnchorEditError, PromotedJourneyEditError, addJourneyAnchor, removeJourneyAnchor, suggestJourneyAnchors, type AnchorEditResult } from "./journey-anchor-api.js";
import { type CliDeps, emitJson, resolveJourneysDir } from "./cli-shared.js";

function collect(value: string, prev: string[]): string[] {
  return [...prev, value];
}

/** One human line per anchor-rule problem left after an edit. */
function renderIssues(result: AnchorEditResult, out: ((s: string) => void) | undefined): void {
  for (const i of result.issues) out?.(`${i.severity}\t${i.code}\t${i.message}\n\t  fix: ${i.fix}\n`);
  out?.(`${result.issues.length} anchor issue(s) — journey '${result.journeyId}'\n`);
  if (result.needsReapproval) {
    out?.(`journey '${result.journeyId}' is promoted: its approval is now stale (kept for the review diff; \`journey review --stale\` lists it, \`check --require-approvals\` fails it)\n`);
    out?.(`re-approve after review: ${result.reapproveCommand}\n`);
  }
}

/** Maps an edit failure to its envelope: unknown id and refused edits are usage errors (64). */
export function anchorEditFailure(program: Command, err: unknown): void {
  if (err instanceof UnknownJourneyError) emitJson(program, fail("E_UNKNOWN_JOURNEY", err.message));
  else if (err instanceof AnchorEditError || err instanceof PromotedJourneyEditError) emitJson(program, fail("E_JOURNEY_ANCHOR_ARGS", err.message));
  else emitJson(program, fail("E_JOURNEY_ANCHOR_ARGS", String(err instanceof Error ? err.message : err)));
}

/**
 * #487 — `jevitate journey anchor add|remove`: edit a Journey's anchors without hand-editing
 * `metadata.anchors`. The step id is written at once; the anchor lint issues that remain are printed.
 */
export function registerJourneyAnchorCommands(journey: Command, program: Command, deps: CliDeps): void {
  const anchor = journey.command("anchor").description("add or remove a draft Journey's anchors (#487): named steps to branch missions off, written with the step's stable id");

  anchor
    .command("add <journeyId>")
    .description("add an anchor to a draft Journey: --step takes a 1-based step number or a step id and writes the step id at once; re-lints and prints the anchor issues")
    .requiredOption("--name <name>", "the anchor's name: 1-64 of lowercase a-z, 0-9, . _ - starting with a letter or digit")
    .requiredOption("--step <n|stepId>", "the step the anchor follows: a 1-based step number or a step id")
    .option("--description <text>", "what this state is, in words")
    .option("--probe <text>", "a suggested adversarial probe at this state (repeatable)", collect, [] as string[])
    .option("--dir <path>", "journeys directory (default: the repo's .jevitate/journeys; outside a repo ~/.jevitate/journeys)")
    .option("--json", "emit a JSON envelope")
    .action(async function (this: Command, journeyId: string) {
      const { name, step, description, probe, dir, json } = this.opts<{ name: string; step: string; description?: string; probe: string[]; dir?: string; json?: boolean }>();
      try {
        const result = await addJourneyAnchor(resolveJourneysDir(deps, dir), journeyId, { name, step, ...(description === undefined ? {} : { description }), probes: probe });
        if (json) emitJson(program, ok(result));
        else {
          const out = program.configureOutput().writeOut;
          out?.(`added anchor '${name}' to journey '${journeyId}' (step ${step})\n`);
          renderIssues(result, out);
          process.exitCode = 0;
        }
      } catch (err) {
        anchorEditFailure(program, err);
      }
    });

  anchor
    .command("remove <journeyId>")
    .description("remove an anchor from a draft Journey; re-lints and prints the anchor issues")
    .requiredOption("--name <name>", "the anchor to remove")
    .option("--dir <path>", "journeys directory (default: the repo's .jevitate/journeys; outside a repo ~/.jevitate/journeys)")
    .option("--json", "emit a JSON envelope")
    .action(async function (this: Command, journeyId: string) {
      const { name, dir, json } = this.opts<{ name: string; dir?: string; json?: boolean }>();
      try {
        const result = await removeJourneyAnchor(resolveJourneysDir(deps, dir), journeyId, name);
        if (json) emitJson(program, ok(result));
        else {
          const out = program.configureOutput().writeOut;
          out?.(`removed anchor '${name}' from journey '${journeyId}'\n`);
          renderIssues(result, out);
          process.exitCode = 0;
        }
      } catch (err) {
        anchorEditFailure(program, err);
      }
    });
}

/**
 * #487 — `journey anchors <id> --suggest`: advisory anchor proposals (a new page, a form that became
 * valid, a completed write), each with the `journey anchor add` command that accepts it. Writes nothing.
 */
export async function runAnchorSuggest(program: Command, deps: CliDeps, id: string, opts: { dir?: string; json?: boolean }): Promise<void> {
  try {
    const result = await suggestJourneyAnchors(resolveJourneysDir(deps, opts.dir), id);
    if (opts.json) {
      emitJson(program, ok(result));
      return;
    }
    const out = program.configureOutput().writeOut;
    for (const s of result.suggestions) {
      out?.(`${s.name}\tstep ${s.step}${s.stepId === undefined ? "" : ` (${s.stepId})`}\t${s.kind}\t${s.reason}\n\tprobes: ${s.probes.join("; ")}\n\t${s.command}\n`);
    }
    out?.(`${result.suggestions.length} suggestion(s) for journey '${id}' — advisory, nothing was written\n`);
    process.exitCode = 0;
  } catch (err) {
    if (err instanceof UnknownJourneyError) emitJson(program, fail("E_UNKNOWN_JOURNEY", err.message));
    else emitJson(program, fail("E_JOURNEY_ANCHORS_ARGS", String(err instanceof Error ? err.message : err)));
  }
}
