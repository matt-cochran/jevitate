import type { JourneyLintFinding } from "@jevitate/journey";
import type { Command } from "commander";
import { type CliDeps, emitJson } from "../cli-shared.js";
import { fail } from "../envelope.js";
import { EXIT_CODES } from "../exit-codes.js";
import { ProjectLayoutError, resolveLayout, type ResolvedLayout } from "../project-layout.js";

/** #401: one human line per lint finding — level, step (when it has one), rule, message. */
/** #432: the targets.json a review sheet reads its site's safety config from (the CLI's own seam). */
export function targetsOpts(deps: CliDeps): { targetsFile?: string } {
  const file = deps.explore?.targetsConfigPath;
  return file === undefined ? {} : { targetsFile: file };
}

export function lintFindingLine(finding: JourneyLintFinding): string {
  const message = finding.message.replace(/^step \d+: /, "");
  return `${finding.level}  ${finding.step === undefined ? "" : `step ${finding.step}  `}${finding.rule}  ${message}${finding.fix === undefined ? "" : ` — fix: ${finding.fix}`}`;
}

export const FULL_FLAG_HELP = "#496: show every detail section: catalog analysis, the full lint list, locator health, provenance, the full change diff";

/** #585: the help every `journey` command keeps on its deprecated `--dir` alias (docs/contracts/project-layout.md §2). */
export const DEPRECATED_DIR_HELP = "deprecated: use --journeys-dir <path> (same meaning); default: the repo's .jevitate/journeys, outside a repo ~/.jevitate/journeys";

/** #585: the location flags of one `journey` invocation — `--project`/`--journeys-dir`, plus the deprecated `--dir`. */
export interface JourneyLayoutFlags {
  readonly project?: string;
  readonly journeysDir?: string;
  readonly dir?: string;
}

/**
 * #585: resolves a `journey` command's locations with `resolveLayout` (docs/contracts/project-layout.md
 * §3/§4, dirMeaning "journeys") — `--project`/`--journeys-dir` win, `--dir` stays the deprecated alias.
 * The deprecation line goes to stderr (never the `--json` stdout envelope). A `ProjectLayoutError`
 * is emitted as the command's refusal (its code and next action, exit 64) and null is returned, so
 * the caller returns without touching the store; any other error propagates.
 */
export function journeyLayout(program: Command, deps: CliDeps, flags: JourneyLayoutFlags): ResolvedLayout | null {
  try {
    const layout = resolveLayout(
      { project: flags.project, journeysDir: flags.journeysDir, dir: flags.dir },
      { dirMeaning: "journeys", deps: { journeysDir: deps.journeysDir } },
    );
    if (layout.deprecation !== undefined) program.configureOutput().writeErr?.(`${layout.deprecation}\n`);
    return layout;
  } catch (err) {
    if (!(err instanceof ProjectLayoutError)) throw err;
    emitJson(program, fail(err.code, `${err.message} — ${err.nextAction}`));
    process.exitCode = EXIT_CODES.usage;
    return null;
  }
}
