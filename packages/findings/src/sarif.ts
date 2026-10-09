import type { ConsolidatedDefect } from "./consolidate.js";
import type { DiffStatus } from "./diff.js";

/**
 * SARIF 2.1.0 for the CI gate (#137), so GitHub code scanning can annotate a PR. One rule per
 * finding signal family (`jevitate/<category>/<signal>`), one result per consolidated finding.
 * `partialFingerprints.jevitateFindingKey` carries the shared finding key, so code scanning tracks
 * the same finding across runs exactly as the baseline diff does.
 *
 * A web finding has no source line, but code scanning needs a physical location: every result is
 * located at the suite file (the thing CI ran), with the route/control as logical locations.
 */

export interface SarifFinding {
  readonly defect: ConsolidatedDefect;
  /** Does this finding fail the gate? (`error` when it does, else `warning`/`note`.) */
  readonly gating: boolean;
  readonly status?: DiffStatus;
}

export interface SarifInput {
  readonly toolVersion: string;
  readonly engineCommit?: string;
  readonly targetBuild?: string;
  /** Repo-relative URI of the suite file (the physical location every result points at). */
  readonly suiteUri: string;
  readonly automationId: string;
  readonly findings: readonly SarifFinding[];
}

export interface SarifLog {
  readonly $schema: string;
  readonly version: "2.1.0";
  readonly runs: readonly unknown[];
}

export const SARIF_SCHEMA = "https://json.schemastore.org/sarif-2.1.0.json";

function ruleId(d: ConsolidatedDefect): string {
  if (d.category === "journey-heal-pending") return PENDING_RULE;
  const signal = d.identity.signal.replace(/[^A-Za-z0-9_.:-]+/g, "-").slice(0, 80);
  return `jevitate/${d.category}/${signal}`;
}

const PENDING_RULE = "jevitate/journey-heal-pending-review";

export function renderSarif(input: SarifInput): SarifLog {
  const rules = new Map<string, { id: string; name: string; shortDescription: { text: string }; defaultConfiguration: { level: string } }>();
  for (const f of input.findings) {
    const id = ruleId(f.defect);
    if (!rules.has(id)) {
      rules.set(id, {
        id,
        name: id.replace(/[^A-Za-z0-9]+/g, "_"),
        shortDescription: { text: `${f.defect.category}: ${f.defect.identity.signal}` },
        defaultConfiguration: { level: f.defect.severity === "hard" ? "error" : f.defect.severity === "pending" ? "warning" : "note" },
      });
    }
  }
  const results = input.findings.map((f) => {
    const d = f.defect;
    const logical = [
      ...(d.identity.route === undefined ? [] : [{ name: d.identity.route, kind: "module" }]),
      ...(d.identity.control === undefined ? [] : [{ name: d.identity.control, kind: "member" }]),
    ];
    // #250: the defect's repro clip and screenshots — SARIF attachments (and related locations, which
    // code scanning lists), so CI shows them with the result.
    const media = d.evidence.flatMap((e) => [
      ...(e.video === undefined ? [] : [{ uri: e.video, text: `captioned repro clip (run ${e.runId})` }]),
      ...(e.screenshot === undefined ? [] : [{ uri: e.screenshot, text: `screenshot${e.step === undefined ? "" : ` at step ${e.step}`} (run ${e.runId})` }]),
    ]);
    const seen = new Set<string>();
    const files = media.filter((m) => (seen.has(m.uri) ? false : (seen.add(m.uri), true))).slice(0, 10);
    const healAttempts = d.evidence.find((e) => e.healAttempts !== undefined)?.healAttempts;
    const proposal = d.evidence.find((e) => e.proposal !== undefined)?.proposal;
    return {
      ruleId: ruleId(d),
      level: f.gating ? "error" : d.severity === "hard" || d.severity === "pending" ? "warning" : "note",
      message: {
        text: `${d.title}${f.status === undefined ? "" : ` [${f.status}]`}${d.reproduce === undefined ? "" : ` — reproduce: ${d.reproduce}`}`,
      },
      locations: [
        {
          physicalLocation: { artifactLocation: { uri: input.suiteUri }, region: { startLine: 1 } },
          ...(logical.length === 0 ? {} : { logicalLocations: logical }),
        },
      ],
      ...(files.length === 0
        ? {}
        : {
            relatedLocations: files.map((m, id) => ({ id, physicalLocation: { artifactLocation: { uri: m.uri } }, message: { text: m.text } })),
            attachments: files.map((m) => ({ artifactLocation: { uri: m.uri }, description: { text: m.text } })),
          }),
      partialFingerprints: { jevitateFindingKey: d.key },
      properties: {
        key: d.key,
        category: d.category,
        severity: d.severity,
        gating: f.gating,
        ...(f.status === undefined ? {} : { status: f.status }),
        modes: d.modes.map((m) => ({ mode: m.mode, occurrences: m.occurrences, runs: m.runs.map((r) => r.runId) })),
        fingerprints: d.fingerprints,
        ...(d.identity.request === undefined ? {} : { request: d.identity.request }),
        // #453: a heal-exhausted Journey's attempts, and a pending one's proposal.
        ...(healAttempts === undefined ? {} : { healAttempts: healAttempts.length }),
        ...(proposal === undefined ? {} : { proposal }),
      },
    };
  });
  return {
    $schema: SARIF_SCHEMA,
    version: "2.1.0",
    runs: [
      {
        tool: {
          driver: {
            name: "jevitate",
            version: input.toolVersion,
            informationUri: "https://jevitate.com",
            rules: [...rules.values()],
          },
        },
        automationDetails: { id: input.automationId },
        results,
        properties: {
          ...(input.engineCommit === undefined ? {} : { engineCommit: input.engineCommit }),
          ...(input.targetBuild === undefined ? {} : { targetBuild: input.targetBuild }),
        },
      },
    ],
  };
}
