import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { consolidate, runFromMissionResult, runFromUxReport, type ConsolidatedDefect, type RunBranch, type RunRecord } from "@jevitate/findings";
import { contractRouteTemplate, uxFindingFingerprint } from "@jevitate/ux";
import { findingIssues, isRouteTemplate, type CatalogBundleFinding } from "./catalog-bundle.js";
import type { CatalogJourney } from "./catalog.js";
import { dedupeSuggestions } from "./locator-health.js";
import { journeyLocatorHealth } from "./locator-health-api.js";
import { defaultReportSources, loadRunFile, scanRuns } from "./report-api.js";
import type { RunIndexDeps } from "./run-index.js";

/**
 * #464 (d464c) — the machine findings a Journeeze catalog bundle carries (journeeze-saas
 * `docs/contract/catalog-bundle-v1.md` §4.4 @ 61f8c92): UX claims, defects and hangs, one per
 * fingerprint (the latest sighting wins). It only READS what the runners persisted (every result
 * was redacted before it was written), from the same places `jevitate report` reads — this
 * project's logs and its indexed runs — plus offline `ux-<stamp>.json` reviews and the committed
 * finding ledger.
 *
 *  - Defects and hangs: `jevitate report`'s deduped list (`consolidate`), with jevitate's own
 *    fingerprint. A declared invariant is a defect. Advisory flags, Journey assertions, goal checks
 *    and approvals have no fingerprint and are not bundle finding kinds: they stay out. The tflowId
 *    is the acting step's (`identity.tflowId`, #468).
 *  - UX: each shown finding of a usability or `ux` report (never the heuristic appendix), with the
 *    contract's derived fingerprint (`uxFindingFingerprint`) over the EXPORTED claim, route and
 *    element — the reader recomputes it. A claim type the contract does not know (a rubric or signal
 *    finding) goes as `other` + `producerClaim`. On-screen `quotes` are never exported.
 *  - Routes are templates (`contractRouteTemplate`: no host, query, fragment or record id).
 *  - Privacy: each finding passes the builder's own guard (`findingIssues`: no personal data, URL
 *    or record id in any text). A finding that cannot is LEFT OUT with a warning naming only its
 *    fingerprint and why — never rewritten into something it did not say, and never allowed to
 *    refuse the whole export. A defect whose own title cannot travel is described by its signal and
 *    route instead (producer-written text).
 *  - No media in 0.10 (no `screenshot`/`box`).
 */

export interface UxReportSource {
  /** The `UxReport` (a usability report file, a usability result's `result.report`, or an offline `ux` review). */
  readonly report: unknown;
  /** The run it came from: when, which build, which Journey step it branched from. */
  readonly run: RunRecord;
}

export interface FindingSources {
  readonly runs: readonly RunRecord[];
  readonly uxReports: readonly UxReportSource[];
}

export interface BundleFindings {
  readonly findings: readonly CatalogBundleFinding[];
  /** Findings left out or degraded, each with why. */
  readonly warnings: readonly string[];
}

const KNOWN_CLAIMS: ReadonlySet<string> = new Set(["next-step-unclear", "no-feedback", "blocked-action", "error-unrecoverable", "destructive-unguarded", "fact-conflict"]);
const PRODUCER_CLAIM_RE = /^[a-z][a-z0-9-]{0,63}$/u;
const FINGERPRINT_RE = /^[0-9a-f]{16}$/u;
const TFLOW_ID_RE = /^[a-z0-9._:-]{1,96}$/u;
const COMMIT_RE = /^[0-9a-f]{7,40}$/u;
const TARGET_ID_RE = /^[A-Za-z0-9_.-]{1,64}$/u;
const JOURNEY_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const DATE_TIME_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,9})?(Z|[+-][0-9]{2}:[0-9]{2})$/u;
const CITATION_SOURCE_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const CITATION_REF_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/u;
const SEVERITIES: ReadonlySet<string> = new Set(["info", "minor", "major"]);
const RESERVED_ANCHORS: ReadonlySet<string> = new Set(["job_start", "job_end"]);
const MAX_CONTROLS = 10;
const MAX_FINDINGS = 5000;

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x !== "") : []);

/** Would this text pass the builder's guard as a finding's `observation` (≤600) / a control (≤120)? */
function safeText(text: string | undefined, as: "observation" | "control"): text is string {
  if (text === undefined) return false;
  const probe: CatalogBundleFinding =
    as === "observation"
      ? { fingerprint: "0000000000000000", kind: "defect", severity: "major", at: "2000-01-01T00:00:00Z", observation: text }
      : { fingerprint: "0000000000000000", kind: "defect", severity: "major", at: "2000-01-01T00:00:00Z", observation: "probe", controls: [text] };
  return findingIssues(probe).length === 0;
}

/** A route as the contract's template, or undefined when it cannot be one. */
function bundleRoute(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const route = contractRouteTemplate(raw);
  return isRouteTemplate(route) ? route : undefined;
}

/** Where it was seen: the Journey step a journey-anchored run branched from. */
function seenAt(branch: RunBranch | undefined): Pick<CatalogBundleFinding, "journey" | "step" | "anchor"> {
  if (branch === undefined || !JOURNEY_ID_RE.test(branch.journeyId)) return {};
  const step = Number.isInteger(branch.step) && branch.step >= 1 && branch.step <= 200 ? branch.step : undefined;
  const anchor = branch.anchor !== undefined && JOURNEY_ID_RE.test(branch.anchor) && !RESERVED_ANCHORS.has(branch.anchor) ? branch.anchor : undefined;
  return { journey: branch.journeyId, ...(step === undefined ? {} : { step }), ...(anchor === undefined ? {} : { anchor }) };
}

function runStamp(run: Pick<RunRecord, "targetBuild" | "targetName">): Pick<CatalogBundleFinding, "commit" | "target"> {
  return {
    ...(run.targetBuild !== undefined && COMMIT_RE.test(run.targetBuild) ? { commit: run.targetBuild } : {}),
    ...(run.targetName !== undefined && TARGET_ID_RE.test(run.targetName) ? { target: run.targetName } : {}),
  };
}

type Mapped = { readonly finding: CatalogBundleFinding } | { readonly drop: string };

/** One defect/hang of the consolidated report as a bundle finding. */
function defectFinding(d: ConsolidatedDefect, runs: ReadonlyMap<string, RunRecord>): Mapped | null {
  if (d.category !== "defect" && d.category !== "invariant" && d.category !== "hang") return null;
  const fingerprint = d.identity.fingerprint;
  if (fingerprint === undefined || !FINGERPRINT_RE.test(fingerprint)) return { drop: `${d.category} ${d.key}: its fingerprint is not 16 hex characters` };
  if (d.lastSeen === undefined || !DATE_TIME_RE.test(d.lastSeen)) return { drop: `finding ${fingerprint}: no run names when it was seen` };
  const latest = d.modes
    .flatMap((m) => m.runs)
    .sort((a, b) => (a.startedAt ?? "").localeCompare(b.startedAt ?? ""))
    .at(-1);
  const run = latest === undefined ? undefined : runs.get(latest.path);
  const route = bundleRoute(d.identity.route);
  const control = d.identity.control;
  const tflowId = d.identity.tflowId;
  const described = `${d.category === "hang" ? "Hang" : "Defect"} (${d.identity.signal}) on ${route ?? "an unknown route"}`;
  return {
    finding: {
      fingerprint,
      kind: d.category === "hang" ? "hang" : "defect",
      severity: "major",
      ...(run === undefined ? {} : runStamp(run)),
      at: d.lastSeen,
      ...seenAt(d.branches?.[0]),
      ...(route === undefined ? {} : { route }),
      ...(tflowId !== undefined && TFLOW_ID_RE.test(tflowId) ? { tflowId } : {}),
      ...(safeText(control, "control") ? { controls: [control] } : {}),
      observation: safeText(d.title, "observation") ? d.title : described,
    },
  };
}

/** One shown finding of a UX report as a bundle finding (the contract's derived fingerprint). */
function uxFinding(f: Record<string, unknown>, run: RunRecord): Mapped {
  const rubric = str(f.rubricItemId) ?? "unknown";
  const route = bundleRoute(str(f.route));
  if (route === undefined) return { drop: `UX finding (${rubric}): its route is not a route template` };
  const type = isRecord(f.claim) ? str(f.claim.type) : undefined;
  const known = type !== undefined && KNOWN_CLAIMS.has(type);
  const producerClaim = known ? undefined : (type ?? rubric);
  if (producerClaim !== undefined && !PRODUCER_CLAIM_RE.test(producerClaim)) return { drop: `UX finding on ${route}: its claim type is not a producer claim name` };
  const claim = (known ? type : "other") as NonNullable<CatalogBundleFinding["claim"]>;
  const severity = str(f.severity);
  const confidence = f.confidence;
  if (severity === undefined || !SEVERITIES.has(severity)) return { drop: `UX finding (${claim}) on ${route}: no contract severity` };
  if (typeof confidence !== "number" || !(confidence >= 0 && confidence <= 1)) return { drop: `UX finding (${claim}) on ${route}: no confidence in [0, 1]` };
  if (run.startedAt === undefined || !DATE_TIME_RE.test(run.startedAt)) return { drop: `UX finding (${claim}) on ${route}: its run names no start time` };
  const observation = str(f.observation);
  if (observation === undefined) return { drop: `UX finding (${claim}) on ${route}: no observation` };
  const tflowRaw = str(f.tflowId);
  const tflowId = tflowRaw !== undefined && TFLOW_ID_RE.test(tflowRaw) ? tflowRaw : undefined;
  const controls = strings(f.controls).slice(0, MAX_CONTROLS);
  const fingerprint = uxFindingFingerprint({ claim, ...(producerClaim === undefined ? {} : { producerClaim }), route, ...(tflowId === undefined ? {} : { tflowId }), controls });
  const citation = isRecord(f.citation) ? { source: str(f.citation.source), ref: str(f.citation.ref) } : undefined;
  const userImpact = str(f.userImpact);
  const recommendation = str(f.recommendation);
  return {
    finding: {
      fingerprint,
      kind: "ux",
      claim,
      ...(producerClaim === undefined ? {} : { producerClaim }),
      severity: severity as CatalogBundleFinding["severity"],
      confidence,
      ...runStamp(run),
      at: run.startedAt,
      ...seenAt(run.branch),
      route,
      ...(tflowId === undefined ? {} : { tflowId }),
      ...(controls.length === 0 ? {} : { controls }),
      observation,
      ...(userImpact === undefined ? {} : { userImpact }),
      ...(recommendation === undefined ? {} : { recommendation }),
      ...(citation?.source !== undefined && citation.ref !== undefined && CITATION_SOURCE_RE.test(citation.source) && CITATION_REF_RE.test(citation.ref)
        ? { citation: { source: citation.source, ref: citation.ref } }
        : {}),
    },
  };
}

/** The warning for a finding the builder's guard drops: the fingerprint and rule, never the offending text. */
function findingDropWarning(fingerprint: string, kind: string, issues: readonly string[]): string {
  return `finding ${fingerprint} (${kind}): ${issues.map((i) => i.replace(/^finding [0-9a-f]+: /u, "").replace(/ "[^"]*"/gu, "")).join("; ")} — left out of the bundle`;
}

/** The bundle's findings from what the runs persisted (pure): one per fingerprint, latest sighting first-class. */
export function bundleFindings(src: FindingSources): BundleFindings {
  const warnings: string[] = [];
  const latest = new Map<string, CatalogBundleFinding>();
  const keep = (m: Mapped | null): void => {
    if (m === null) return;
    if ("drop" in m) {
      warnings.push(`${m.drop} — left out of the bundle`);
      return;
    }
    const issues = findingIssues(m.finding);
    if (issues.length > 0) {
      // Name the fingerprint and the rule only: the offending text never reaches a warning.
      warnings.push(findingDropWarning(m.finding.fingerprint, m.finding.kind, issues));
      return;
    }
    const prev = latest.get(m.finding.fingerprint);
    if (prev === undefined || prev.at <= m.finding.at) latest.set(m.finding.fingerprint, m.finding);
  };
  const byPath = new Map(src.runs.map((r) => [r.path, r]));
  for (const d of consolidate(src.runs)) keep(defectFinding(d, byPath));
  for (const { report, run } of src.uxReports) {
    if (!isRecord(report) || !Array.isArray(report.findings)) continue;
    for (const f of report.findings) if (isRecord(f)) keep(uxFinding(f, run));
  }
  let findings = [...latest.values()].sort((a, b) => a.at.localeCompare(b.at) || a.fingerprint.localeCompare(b.fingerprint));
  if (findings.length > MAX_FINDINGS) {
    warnings.push(`${findings.length} findings: only the latest ${MAX_FINDINGS} are exported`);
    findings = findings.slice(-MAX_FINDINGS);
  }
  return { findings, warnings };
}

/**
 * #479 (minor 1) — the locator findings: one per brittle ELEMENT (§4.4, spec bundle-minor1 §1). Each
 * promoted Journey's locator health (`journeyLocatorHealth`) becomes suggestions, de-duplicated by
 * element across Journeys; each suggestion is a `kind: "ux"` / claim `other` / producerClaim
 * `locator-brittle` finding, dated at the latest approval of the Journeys it occurs in. A suggestion
 * whose route cannot be a template, that has no approval time, or that fails the builder's privacy
 * guard is LEFT OUT with a warning. Pure: no clock, no I/O.
 */
export function locatorFindings(journeys: readonly CatalogJourney[], testIdAttributes: readonly string[]): BundleFindings {
  const warnings: string[] = [];
  const suggestions = dedupeSuggestions(journeys.map((cj) => journeyLocatorHealth(cj.journey, testIdAttributes).suggestions));
  const approvalAt = new Map<string, string>();
  for (const cj of journeys) {
    const at = cj.approval?.at;
    if (at !== undefined && DATE_TIME_RE.test(at)) approvalAt.set(cj.id, at);
  }
  const findings: CatalogBundleFinding[] = [];
  for (const s of suggestions) {
    const route = bundleRoute(s.route);
    if (s.route !== undefined && route === undefined) {
      warnings.push(`locator ${s.key}: its route is not a route template — left out of the bundle`);
      continue;
    }
    const first = s.occurrences[0];
    if (first === undefined) continue;
    const at = s.occurrences
      .map((o) => (o.journeyId === undefined ? undefined : approvalAt.get(o.journeyId)))
      .filter((v): v is string => v !== undefined)
      .sort()
      .at(-1);
    if (at === undefined) {
      warnings.push(`locator ${s.key}: no approval time to date it — left out of the bundle`);
      continue;
    }
    const key = s.key.slice(s.key.indexOf("|") + 1);
    const fingerprint = createHash("sha256").update(`ux\nlocator-brittle\n${route ?? ""}\n${key}`, "utf8").digest("hex").slice(0, 16);
    const step = first.index + 1;
    // The fix names the page by its raw path; the bundle only ever carries the route template.
    const fix = s.route !== undefined && route !== undefined && s.route !== route ? s.fix.split(s.route).join(route) : s.fix;
    const finding: CatalogBundleFinding = {
      fingerprint,
      kind: "ux",
      claim: "other",
      producerClaim: "locator-brittle",
      severity: "minor",
      at,
      ...(first.journeyId === undefined ? {} : { journey: first.journeyId }),
      ...(step < 1 || step > 200 ? {} : { step }),
      ...(route === undefined ? {} : { route }),
      observation: `${s.element} on ${route ?? "an unknown page"} is found by a brittle locator (${s.reasons.join(", ")})`,
      recommendation: fix,
      locator: { element: s.element, attribute: s.attribute, testId: s.testId, fix, steps: s.occurrences.length },
    };
    const issues = findingIssues(finding);
    if (issues.length > 0) {
      warnings.push(findingDropWarning(fingerprint, finding.kind, issues));
      continue;
    }
    findings.push(finding);
  }
  return { findings, warnings };
}

// ── I/O: where the project's findings live ──────────────────────────────────────────────────

const OFFLINE_UX_REPORT = /^ux-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.json$/u;

function readJsonOrNull(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    return null; // unreadable/partial: not a source (never a fabricated one)
  }
}

/** The ledger's entries as runs: each is a redacted mission result holding one defect or hang. */
function ledgerRuns(dataDir: string | null): RunRecord[] {
  if (dataDir === null) return [];
  const dir = join(dataDir, "regressions", "ledger");
  if (!existsSync(dir)) return [];
  const out: RunRecord[] = [];
  for (const f of readdirSync(dir).sort()) {
    if (!/^[0-9a-f]{16}\.json$/u.test(f)) continue;
    const entry = readJsonOrNull(join(dir, f));
    if (!isRecord(entry) || !isRecord(entry.ledger) || !isRecord(entry.result)) continue;
    const meta = entry.ledger;
    const source = isRecord(meta.source) ? meta.source : {};
    const run = runFromMissionResult(join(dir, f), {
      missionOutcome: str(source.missionOutcome) ?? "defects-found",
      result: { ...(str(meta.addedAt) === undefined ? {} : { startedAt: str(meta.addedAt) }), ...entry.result },
    });
    if (run !== null) out.push(run);
  }
  return out;
}

export interface CollectBundleFindingsOptions {
  /** The project root (where its `.jevitate/` is). */
  readonly root: string;
  /** The project data dir (`--dir`, else `<root>/.jevitate`); null outside a project. */
  readonly dataDir: string | null;
  /** Test seam: the run index. */
  readonly index?: RunIndexDeps;
}

/** Reads the project's runs, UX reports and ledger, and returns the bundle's findings. */
export async function collectBundleFindings(opts: CollectBundleFindingsOptions): Promise<BundleFindings> {
  const sources = defaultReportSources(false, { cwd: () => opts.root, ...opts.index });
  const runs = scanRuns(sources.dirs);
  const seen = new Set(runs.map((r) => resolve(r.path)));
  for (const f of sources.files) {
    if (seen.has(resolve(f))) continue;
    seen.add(resolve(f));
    const run = loadRunFile(f);
    if (run !== null) runs.push(run);
  }
  const uxReports: UxReportSource[] = [];
  for (const run of runs) {
    if (run.mode !== "usability") continue;
    const raw = readJsonOrNull(run.path);
    const report = isRecord(raw) && Array.isArray(raw.findings) ? raw : isRecord(raw) && isRecord(raw.result) ? raw.result.report : undefined;
    if (report !== undefined) uxReports.push({ report, run });
  }
  for (const dir of sources.dirs) {
    if (!existsSync(dir) || !statSync(dir).isDirectory()) continue;
    for (const f of readdirSync(dir).sort()) {
      if (!OFFLINE_UX_REPORT.test(f)) continue;
      const path = join(dir, f);
      const raw = readJsonOrNull(path);
      const run = runFromUxReport(path, raw);
      if (run !== null) uxReports.push({ report: raw, run });
    }
  }
  return bundleFindings({ runs: [...runs, ...ledgerRuns(opts.dataDir)], uxReports });
}
