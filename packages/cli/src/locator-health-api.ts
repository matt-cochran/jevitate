import { readFile } from "node:fs/promises";
import { FsJourneyStore, type Journey } from "@jevitate/journey";
import type { LocatorHealthSummary } from "./check-types.js";
import {
  analyzeRecording,
  combineHealth,
  compactHealth,
  compareLocatorHealth,
  trendLine,
  type CompactLocatorHealth,
  type LocatorHealthDetail,
  type LocatorHealthTrend,
  type LocatorLevels,
  type LocatorSuggestion,
  type ResolvedStepInput,
} from "./locator-health.js";
import { DEFAULT_TEST_ID_ATTRIBUTES, loadProjectConfig } from "./project-config.js";
import { findProjectDir } from "./project-dir.js";

/**
 * #470 — locator health: how stable each recorded step's target is against the team's test-id
 * convention (the selector-ladder rung it resolves by; `data-tflow-id` never counts, #468), why a
 * brittle one is brittle, and the fix for the app. Advisory everywhere (result.json, report,
 * check.json warnings, the review sheet); `check` gates only past the team's opt-in threshold
 * `--max-brittle-steps <n>`. The analysis itself is pure (`locator-health.ts`); this module loads.
 *
 * - `jevitate locator-health [--journey <id> | --run <result.json>] [--baseline <file>]` / MCP
 *   `locator_health` (read-only): every promoted Journey by default, one Journey, or the steps of one
 *   run result (the rung each step actually resolved by, when the run recorded it).
 * - The test-id attribute list is project config (`testIdAttributes` in `<repo>/.jevitate/project.json`;
 *   default `data-testid`, `data-test`; teams add e.g. `data-cy`, `data-qa`) — never a flag.
 */

export { DEFAULT_TEST_ID_ATTRIBUTES };

export interface LocatorHealthRequest {
  /** The journeys dir (`--dir`, else the repo's `.jevitate/journeys`). */
  readonly journeysDir: string;
  /** The project data dir whose config holds `testIdAttributes`; null outside a project (defaults apply). */
  readonly projectDir: string | null;
  /** `--journey <id>`: just this Journey (exclusive with `runResult`). */
  readonly journeyId?: string;
  /** `--run <result.json>`: the steps of this run result (exclusive with `journeyId`). */
  readonly runResult?: string;
  /**
   * `--baseline <file>`: a previous `locator-health --json` output (or a run's result.json) to report
   * the trend against — steps improved / regressed per Journey.
   */
  readonly baseline?: string;
}

export interface LocatorHealthJourney {
  readonly id: string;
  readonly health: LocatorHealthDetail;
  /** Against `--baseline`, when the baseline has this Journey. */
  readonly trend?: LocatorHealthTrend;
}

export interface LocatorHealthReport {
  readonly source: { readonly kind: "journeys" } | { readonly kind: "journey"; readonly id: string } | { readonly kind: "run"; readonly path: string };
  /** The convention applied (from project config, else DEFAULT_TEST_ID_ATTRIBUTES). */
  readonly testIdAttributes: readonly string[];
  readonly journeys: readonly LocatorHealthJourney[];
  readonly summary: LocatorHealthSummary & { readonly levels: LocatorLevels; readonly line: string };
  /** The work list for the app: one fix per element, de-duplicated across steps and Journeys. */
  readonly suggestions: readonly LocatorSuggestion[];
  /** Totals against `--baseline`. */
  readonly trend?: LocatorHealthTrend & { readonly baseline: string; readonly line: string };
}

export class LocatorHealthInputError extends Error {
  readonly code = "E_LOCATOR_HEALTH_INPUT";
  constructor(message: string) {
    super(message);
    this.name = "LocatorHealthInputError";
  }
}

/** The project's test-id convention (throws `ProjectConfigError` on a malformed config). */
export function testIdAttributesOf(projectDir: string | null): readonly string[] {
  return loadProjectConfig(projectDir).testIdAttributes;
}

/**
 * The convention for a writer that must not fail on it (a run's result.json): the project's, else the
 * default when the config is malformed — `jevitate locator-health` is where a bad config is reported.
 */
export function testIdAttributesOrDefault(projectDir: string | null = findProjectDir()): readonly string[] {
  try {
    return testIdAttributesOf(projectDir);
  } catch {
    return DEFAULT_TEST_ID_ATTRIBUTES;
  }
}

/** A Journey's (static) or a run's (with `resolved`) locator health. */
export function journeyLocatorHealth(journey: Journey, testIdAttributes: readonly string[], resolved?: readonly ResolvedStepInput[]): LocatorHealthDetail {
  return analyzeRecording(journey.recording, { testIdAttributes, journeyId: journey.metadata.id, ...(resolved === undefined ? {} : { resolved }) });
}

/**
 * What a Journey run's result.json carries (`result.locatorHealth`): the compact health of the run —
 * the rung each step resolved by when the run recorded it. Undefined when no step acts on a target.
 */
export function runLocatorHealth(
  journey: Journey,
  resolved: readonly ResolvedStepInput[] | undefined,
  testIdAttributes: readonly string[] = testIdAttributesOrDefault(),
): CompactLocatorHealth | undefined {
  const health = journeyLocatorHealth(journey, testIdAttributes, resolved);
  return health.steps.length === 0 ? undefined : compactHealth(health);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

async function readJson(path: string, what: string): Promise<unknown> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    throw new LocatorHealthInputError(`${what}: cannot read ${path} (${err instanceof Error ? err.message : String(err)})`);
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new LocatorHealthInputError(`${what}: ${path} is not JSON`);
  }
}

/** A run result's journey id and resolutions (`{result: {mode: "journey", journeyId, resolved}}`). */
function runOf(json: unknown, path: string, what: string): { journeyId: string; resolved?: ResolvedStepInput[]; health?: unknown } {
  const result = isRecord(json) && isRecord(json.result) ? json.result : isRecord(json) ? json : undefined;
  const journeyId = result !== undefined && typeof result.journeyId === "string" ? result.journeyId : undefined;
  if (result === undefined || journeyId === undefined) throw new LocatorHealthInputError(`${what}: ${path} is not a Journey run result (no result.journeyId)`);
  const resolved = Array.isArray(result.resolved)
    ? result.resolved.filter((r): r is ResolvedStepInput => isRecord(r) && typeof r.index === "number" && typeof r.rung === "string")
    : undefined;
  return { journeyId, ...(resolved === undefined ? {} : { resolved }), ...(result.locatorHealth === undefined ? {} : { health: result.locatorHealth }) };
}

type TrendInput = Parameters<typeof compareLocatorHealth>[1];

function asTrendInput(h: unknown): TrendInput | undefined {
  if (!isRecord(h) || typeof h.brittle !== "number" || !Array.isArray(h.steps)) return undefined;
  return h as unknown as TrendInput;
}

/** Per-Journey baseline healths: a `locator-health --json` output (envelope or report) or a run result. */
function baselineOf(json: unknown, path: string): Map<string, TrendInput> {
  const out = new Map<string, TrendInput>();
  const report = isRecord(json) && isRecord(json.data) ? json.data : json;
  if (isRecord(report) && Array.isArray(report.journeys)) {
    for (const j of report.journeys) {
      if (!isRecord(j) || typeof j.id !== "string") continue;
      const h = asTrendInput(j.health);
      if (h !== undefined) out.set(j.id, h);
    }
    return out;
  }
  const run = runOf(json, path, "--baseline");
  const h = asTrendInput(run.health);
  if (h === undefined) throw new LocatorHealthInputError(`--baseline: ${path} carries no locator health (a locator-health --json output, or a run result that recorded it)`);
  out.set(run.journeyId, h);
  return out;
}

async function loadJourney(store: FsJourneyStore, id: string, dir: string): Promise<Journey> {
  const j = await store.get(id);
  if (j === null) throw new LocatorHealthInputError(`no Journey '${id}' in ${dir}`);
  return j;
}

function sumTrends(trends: readonly LocatorHealthTrend[]): LocatorHealthTrend {
  const sum = (k: "improved" | "regressed" | "unchanged" | "added" | "removed" | "brittleDelta"): number => trends.reduce((n, t) => n + t[k], 0);
  return {
    improved: sum("improved"),
    regressed: sum("regressed"),
    unchanged: sum("unchanged"),
    added: sum("added"),
    removed: sum("removed"),
    brittleDelta: sum("brittleDelta"),
    changes: trends.flatMap((t) => t.changes),
  };
}

/** Read-only: never changes a Journey and never gates (the exit code is 0 on any report). */
export async function locatorHealth(req: LocatorHealthRequest): Promise<LocatorHealthReport> {
  const testIdAttributes = testIdAttributesOf(req.projectDir);
  const store = new FsJourneyStore(req.journeysDir);
  let journeys: LocatorHealthJourney[] = [];
  let source: LocatorHealthReport["source"];
  if (req.runResult !== undefined) {
    const run = runOf(await readJson(req.runResult, "--run"), req.runResult, "--run");
    const journey = await loadJourney(store, run.journeyId, req.journeysDir);
    journeys.push({ id: journey.metadata.id, health: journeyLocatorHealth(journey, testIdAttributes, run.resolved) });
    source = { kind: "run", path: req.runResult };
  } else if (req.journeyId !== undefined) {
    const journey = await loadJourney(store, req.journeyId, req.journeysDir);
    journeys.push({ id: journey.metadata.id, health: journeyLocatorHealth(journey, testIdAttributes) });
    source = { kind: "journey", id: req.journeyId };
  } else {
    const listed = (await store.list()).filter((m) => m.promoted).sort((a, b) => a.id.localeCompare(b.id));
    for (const m of listed) {
      const journey = await store.get(m.id);
      if (journey !== null) journeys.push({ id: journey.metadata.id, health: journeyLocatorHealth(journey, testIdAttributes) });
    }
    source = { kind: "journeys" };
  }

  let trend: LocatorHealthReport["trend"];
  if (req.baseline !== undefined) {
    const base = baselineOf(await readJson(req.baseline, "--baseline"), req.baseline);
    journeys = journeys.map((j) => {
      const b = base.get(j.id);
      return b === undefined ? j : { ...j, trend: compareLocatorHealth(j.health, b) };
    });
    const total = sumTrends(journeys.flatMap((j) => (j.trend === undefined ? [] : [j.trend])));
    trend = { ...total, baseline: req.baseline, line: trendLine(total) };
  }

  const all = combineHealth(journeys.map((j) => j.health));
  return {
    source,
    testIdAttributes,
    journeys,
    summary: { journeys: journeys.length, stable: all.stable, brittle: all.brittle, testIdAttributes, levels: all.levels, line: all.line },
    suggestions: all.suggestions,
    ...(trend === undefined ? {} : { trend }),
  };
}

/** The human rendering (no `--json`): per Journey and its brittle steps, the totals, the trend and the work list. */
export function renderLocatorHealth(r: LocatorHealthReport, opts: { readonly top?: number } = {}): string {
  const lines: string[] = [];
  for (const j of r.journeys) {
    lines.push(`${String(j.health.brittle).padStart(4)} brittle / ${j.health.stable} stable  ${j.id}  (${j.health.line})${j.trend === undefined ? "" : `  [${trendLine(j.trend)}]`}`);
    for (const s of j.health.steps) {
      if (s.stability === "stable") continue;
      lines.push(`       step ${s.index + 1}${s.stepId === undefined ? "" : ` (${s.stepId})`} ${s.kind} ${s.locator} — ${s.rung}, ${s.level}: ${s.reasons.join("; ")}`);
    }
  }
  lines.push(`${r.summary.line} across ${r.summary.journeys} Journey(s) (test ids: ${r.testIdAttributes.join(", ")})`);
  if (r.trend !== undefined) lines.push(r.trend.line);
  const top = opts.top ?? 10;
  if (r.suggestions.length > 0) {
    lines.push(`fixes for the app (${r.suggestions.length} element(s)):`);
    for (const s of r.suggestions.slice(0, top)) lines.push(`  - ${s.fix}  [${s.occurrences.length} step(s): ${s.reasons.join("; ")}]`);
    if (r.suggestions.length > top) lines.push(`  … ${r.suggestions.length - top} more (--json for all)`);
  }
  return `${lines.join("\n")}\n`;
}

/**
 * `check --max-brittle-steps <n>`: the opt-in gate — a Journey item with more than `n` brittle steps
 * is a gating finding. Called by check-cli before the suite runs; `exceedsBrittleSteps(health, n)`
 * (locator-health.ts) is the per-item verdict.
 *
 * Contract for check integration: add `maxBrittleSteps?: number` to `RunCheckOptions` (check-types.ts)
 * and have check-cli pass `gate.maxBrittleSteps` through to `runCheck`; check.json reports it in
 * `LocatorHealthSummary.maxBrittleSteps` / `exceeded`.
 */
export interface BrittleStepGate {
  readonly maxBrittleSteps: number;
}

export function brittleStepGate(maxBrittleSteps: number): BrittleStepGate {
  if (!Number.isInteger(maxBrittleSteps) || maxBrittleSteps < 0) throw new RangeError(`--max-brittle-steps must be a whole number ≥ 0, got ${maxBrittleSteps}`);
  return { maxBrittleSteps };
}
