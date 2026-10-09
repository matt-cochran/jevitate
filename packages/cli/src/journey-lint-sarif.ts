import { ANCHOR_RULE_CODES, type JourneyLintFinding, type JourneyLintRule } from "@jevitate/journey";

/**
 * #401: SARIF 2.1.0 for `journey lint`, so CI can gate on assertion strength the same way it does
 * on `jevitate check` findings. One tool driver (`jevitate-journey-lint`) lists every rule; one
 * result per finding carries its level and message, located at the journey id and (when present)
 * `step N` as logical locations. #466: the anchor rules are warnings; a finding's fix is appended to
 * its message and kept as `properties.fix`.
 */

export const JOURNEY_LINT_SARIF_SCHEMA = "https://json.schemastore.org/sarif-2.1.0.json";

/** #401: every rule the lint can report, with the severity it reports it at. */
const RULES: ReadonlyArray<{ id: JourneyLintRule; level: "error" | "warning" }> = [
  { id: "own-target-visible", level: "error" },
  { id: "write-without-effect", level: "error" },
  { id: "visibility-only", level: "error" },
  { id: "nothing-after-last-write", level: "error" },
  { id: "no-persistence-check", level: "warning" },
  { id: "intent-uncovered", level: "warning" },
  // #466: the 0.10 anchor rules — warnings on a Journey as it is; `journey promote` enforces them on new content.
  ...ANCHOR_RULE_CODES.map((id) => ({ id, level: "warning" as const })),
  { id: "anchor-job-step", level: "warning" },
  { id: "serves-outcome", level: "warning" },
];

export interface JourneyLintSarifLog {
  readonly $schema: string;
  readonly version: "2.1.0";
  readonly runs: readonly unknown[];
}

export interface JourneyLintSarifInput {
  readonly id: string;
  readonly findings: readonly JourneyLintFinding[];
  readonly version: string;
}

export function renderJourneyLintSarif(input: JourneyLintSarifInput): JourneyLintSarifLog {
  const rules = RULES.map((rule) => ({
    id: rule.id,
    name: rule.id,
    shortDescription: { text: rule.id },
    defaultConfiguration: { level: rule.level },
  }));
  const results = input.findings.map((finding) => ({
    ruleId: finding.rule,
    level: finding.level,
    message: { text: finding.fix === undefined ? finding.message : `${finding.message} — fix: ${finding.fix}` },
    ...(finding.fix === undefined ? {} : { properties: { fix: finding.fix } }),
    locations: [
      {
        logicalLocations: [
          { name: input.id, kind: "module" },
          ...(finding.step === undefined ? [] : [{ name: `step ${finding.step}`, kind: "function" }]),
        ],
      },
    ],
  }));
  return {
    $schema: JOURNEY_LINT_SARIF_SCHEMA,
    version: "2.1.0",
    runs: [
      {
        tool: { driver: { name: "jevitate-journey-lint", version: input.version, rules } },
        results,
      },
    ],
  };
}
