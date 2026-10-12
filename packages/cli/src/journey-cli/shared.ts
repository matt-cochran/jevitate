import type { JourneyLintFinding } from "@jevitate/journey";
import type { CliDeps } from "../cli-shared.js";

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
