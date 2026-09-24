import type { ConsolidatedDefect } from "./consolidate.js";
import { DIFF_STATUSES, type FindingsDiff } from "./diff.js";
import type { RunRecord } from "./extract.js";

/** The consolidated defect list (#139) as markdown, with the baseline diff (#138) when given. */
export interface ReportMarkdownInput {
  readonly title: string;
  readonly runs: readonly RunRecord[];
  readonly defects: readonly ConsolidatedDefect[];
  readonly diff?: FindingsDiff;
}

function cell(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();
}

function evidenceLine(e: ConsolidatedDefect["evidence"][number]): string {
  const parts = [
    `run \`${e.runId}\``,
    e.step === undefined ? undefined : `step ${e.step}`,
    e.screen === undefined ? undefined : `screen ${e.screen}`,
    e.request === undefined ? undefined : `request \`${e.request}\``,
    e.url === undefined ? undefined : `url \`${e.url}\``,
    e.screenshot === undefined ? undefined : `screenshot \`${e.screenshot}\``,
    e.transcript === undefined ? undefined : `transcript \`${e.transcript}\``,
    e.recording === undefined ? undefined : `recording \`${e.recording}\``,
  ].filter((p): p is string => p !== undefined);
  return `  - ${parts.join(" · ")}`;
}

function defectSection(d: ConsolidatedDefect, status?: string): string[] {
  const id = d.identity;
  const lines = [
    `### ${status === undefined ? "" : `[${status}] `}${d.title}`,
    "",
    `- key: \`${d.key}\` · ${d.severity} · ${d.category}${d.intermittent ? " · intermittent" : ""}`,
    `- identity: signal \`${id.signal}\`${id.route === undefined ? "" : ` · route \`${id.route}\``}${
      id.control === undefined ? "" : ` · control \`${id.control}\``
    }${id.request === undefined ? "" : ` · request \`${id.request}\``}`,
    `- seen: ${d.occurrences} occurrence(s) in ${d.runCount} run(s)${d.firstSeen === undefined ? "" : `, first ${d.firstSeen}`}${
      d.lastSeen === undefined ? "" : `, last ${d.lastSeen}`
    }`,
    "- modes:",
    ...d.modes.map(
      (m) => `  - ${m.mode}: ${m.occurrences} occurrence(s) in ${m.runs.length} run(s) — ${m.runs.map((r) => `\`${r.runId}\` ×${r.occurrences}`).join(", ")}`,
    ),
  ];
  if (d.evidence.length > 0) lines.push("- evidence:", ...d.evidence.slice(0, 8).map(evidenceLine));
  if (d.reproduce !== undefined) lines.push(`- reproduce: \`${d.reproduce}\``);
  lines.push("");
  return lines;
}

export function renderReportMarkdown(input: ReportMarkdownInput): string {
  const hard = input.defects.filter((d) => d.severity === "hard");
  const advisory = input.defects.filter((d) => d.severity === "advisory");
  const builds = [...new Set(input.runs.map((r) => r.targetBuild).filter((b): b is string => b !== undefined))];
  const engines = [...new Set(input.runs.map((r) => r.engine?.commit).filter((c): c is string => c !== undefined))];
  const out: string[] = [
    `# ${input.title}`,
    "",
    `${hard.length} defect(s), ${advisory.length} advisory finding(s) across ${input.runs.length} run(s).`,
    ...(builds.length === 0 ? [] : [`Target build(s): ${builds.map((b) => `\`${b}\``).join(", ")}.`]),
    ...(engines.length === 0 ? [] : [`Engine commit(s): ${engines.map((c) => `\`${c}\``).join(", ")}.`]),
    "",
  ];
  const statusOf = new Map(input.diff?.entries.map((e) => [e.key, e.status]) ?? []);
  if (input.diff !== undefined) {
    out.push(
      "## Diff against baseline",
      "",
      "| status | count |",
      "| --- | --- |",
      ...DIFF_STATUSES.map((s) => `| ${s} | ${input.diff?.summary[s] ?? 0} |`),
      "",
      "| status | key | severity | title | baseline | current |",
      "| --- | --- | --- | --- | --- | --- |",
      ...input.diff.entries.map(
        (e) =>
          `| ${e.status} | \`${e.key}\` | ${e.defect.severity} | ${cell(e.defect.title)} | ${e.baseline.seen}/${e.baseline.of} | ${e.current.seen}/${e.current.of} |`,
      ),
      "",
    );
  }
  out.push("## Defects", "");
  if (hard.length === 0) out.push("None.", "");
  for (const d of hard) out.push(...defectSection(d, statusOf.get(d.key)));
  out.push("## Advisory findings", "", "Advisory findings (UX, 4xx-correlated console errors, Jev flags) never gate on their own.", "");
  if (advisory.length === 0) out.push("None.", "");
  for (const d of advisory) out.push(...defectSection(d, statusOf.get(d.key)));
  out.push(
    "## Runs",
    "",
    "| run | mode | target | started | outcome | build |",
    "| --- | --- | --- | --- | --- | --- |",
    ...input.runs.map(
      (r) => `| \`${r.runId}\` | ${r.mode} | ${r.target ?? ""} | ${r.startedAt ?? ""} | ${r.missionOutcome ?? ""} | ${r.targetBuild ?? ""} |`,
    ),
    "",
  );
  return out.join("\n");
}
