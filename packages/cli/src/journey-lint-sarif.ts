import type { JourneyLintFinding, JourneyLintRule } from "@jevitate/journey";

/**
 * #401: SARIF 2.1.0 for `journey lint`, so CI can gate on assertion strength the same way it does
 * on `jevitate check` findings. One tool driver (`jevitate-journey-lint`) lists every rule; one
 * result per finding carries its level and message, located at the journey id and (when present)
 * `step N` as logical locations.
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
    message: { text: finding.message },
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
