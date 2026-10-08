import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { allResultDirs, projectDataDir } from "./project-dir.js";
import { indexedRunsFor, projectLogDirs, type RunIndexDeps } from "./run-index.js";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import {
  consolidate,
  diffRuns,
  renderReportMarkdown,
  runFromMissionResult,
  runFromUxReport,
  runIdOf,
  type ConsolidatedDefect,
  type FindingsDiff,
  type RunRecord,
} from "@jevitate/findings";
import { formatUsageLine, sumUsage, usageCountsFrom, type UsageAggregate } from "@jevitate/ai-core";
import { resolveDataDir } from "./data-dir.js";
import { clock, matchesRunTags } from "@jevitate/domain";

/**
 * The programmatic surface behind `jevitate report` (#139), `jevitate diff` / `--baseline` (#138)
 * and `jevitate baseline tag`. It only READS what the runners already persisted — every result was
 * redacted before it was written, so nothing here can surface a secret the result did not already
 * hold; a report adds no page data and makes no model call.
 *
 * A "run reference" (a `<run>` argument) is, in order: a file path (a `<stem>.result.json`, a
 * usability report, or a `jevitate check` record naming its results), a baseline tag name, or a
 * run id (a result file's stem, looked up in the result dirs).
 */

export class ReportInputError extends Error {
  readonly code = "E_REPORT_INPUT" as const;
  constructor(message: string) {
    super(message);
    this.name = "ReportInputError";
  }
}

/** Where results live by default: mission results next to their Recordings, and UX reports. */
export function defaultResultDirs(): string[] {
  return allResultDirs();
}

/**
 * #213: where a report reads by default. A bare `report` reads the CURRENT project only: its own
 * `.jevitate/logs` (none outside a project) plus every run the run index recorded for this project —
 * including runs written to an `--out` dir. With `--target`, every results dir is read too (the
 * target filter keeps it to that app), plus the indexed runs.
 */
export function defaultReportSources(withTarget: boolean, deps: RunIndexDeps = {}): { dirs: string[]; files: string[] } {
  return { dirs: withTarget ? allResultDirs(deps) : projectLogDirs(deps), files: indexedRunsFor(deps) };
}

/** #213: where `diff`/`baseline tag` look a run id up: this project's sources first, then every results dir. */
export function defaultLookupDirs(deps: RunIndexDeps = {}): string[] {
  return [...new Set([...projectLogDirs(deps), ...parentDirs(indexedRunsFor(deps)), ...allResultDirs(deps)])];
}

function parentDirs(files: readonly string[]): string[] {
  return [...new Set(files.map((f) => dirname(f)))];
}

/** A scan plus the indexed result files it did not already read (each path once), oldest first. */
function withFiles(scanned: RunRecord[], files: readonly string[]): RunRecord[] {
  const seen = new Set(scanned.map((r) => resolve(r.path)));
  const out = [...scanned];
  for (const f of files) {
    const path = resolve(f);
    if (seen.has(path)) continue;
    // A usability report whose persisted result is indexed too is the same run (read from the result).
    if (UX_REPORT.test(basename(path)) && existsSync(`${path.slice(0, -".json".length)}.recording.result.json`)) continue;
    seen.add(path);
    const run = loadRunFile(path);
    if (run !== null) out.push(run);
  }
  return out.sort((a, b) => (a.startedAt ?? "").localeCompare(b.startedAt ?? "") || a.runId.localeCompare(b.runId));
}

/** The targets a report could be asked for: the runs' origins and suite target names, and registered mission targets. */
async function knownTargets(pool: readonly RunRecord[], missionTargetsDir: string): Promise<string[]> {
  const known = new Set<string>();
  for (const r of pool) {
    if (r.target !== undefined) known.add(r.target);
    if (r.targetName !== undefined) known.add(r.targetName);
  }
  if (existsSync(missionTargetsDir)) {
    for (const f of await readdir(missionTargetsDir)) {
      if (!f.endsWith(".json")) continue;
      try {
        const t = JSON.parse(await readFile(join(missionTargetsDir, f), "utf8")) as unknown;
        if (isRecord(t) && typeof t.name === "string") known.add(t.name);
      } catch {
        continue;
      }
    }
  }
  return [...known].sort();
}

export function defaultBaselinesDir(): string {
  return projectDataDir(["baselines"]);
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

const UX_REPORT = /^usability-.*\d{3}Z\.json$/;

/** Is this file name one a result scan reads? (Recordings, transcripts and drafts are not.) */
function isResultName(name: string): boolean {
  return name.endsWith(".result.json") || UX_REPORT.test(name);
}

/** Reads one persisted result file into a run. Null for a file that is not a result. */
export function loadRunFile(path: string): RunRecord | null {
  let raw: unknown;
  try {
    raw = readJson(path);
  } catch {
    return null; // an unreadable/partial file is not a run (never a fabricated empty one)
  }
  if (UX_REPORT.test(basename(path))) {
    const stem = path.slice(0, -".json".length);
    let site: string | undefined;
    try {
      const rec = readJson(`${stem}.recording.json`);
      if (isRecord(rec) && typeof rec.site === "string") site = rec.site;
    } catch {
      site = undefined; // no sibling Recording: the report's origin is unknown
    }
    return runFromUxReport(path, raw, { ...(site === undefined ? {} : { site }), screenshotDir: `${stem}.screens` });
  }
  return runFromMissionResult(path, raw);
}

const MAX_SCAN_DEPTH = 8;

/**
 * Every result in `dirs` and their subdirectories (#171: a `runs/<id>/…result.json` layout), oldest
 * first. Missing dirs are skipped; dot-dirs, `node_modules` and symlinked dirs are not walked.
 */
export function scanRuns(dirs: readonly string[]): RunRecord[] {
  const seen = new Set<string>();
  const runs: RunRecord[] = [];
  const walk = (dir: string, depth: number): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = resolve(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth < MAX_SCAN_DEPTH && !entry.name.startsWith(".") && entry.name !== "node_modules") walk(path, depth + 1);
        continue;
      }
      if (!entry.isFile() || !isResultName(entry.name) || seen.has(path)) continue;
      // #213: a usability report next to its persisted result (`<stem>.recording.result.json`, which
      // carries the same report) is the same run — read once, from the result.
      if (UX_REPORT.test(entry.name) && existsSync(`${path.slice(0, -".json".length)}.recording.result.json`)) continue;
      seen.add(path);
      const run = loadRunFile(path);
      if (run !== null) runs.push(run);
    }
  };
  for (const dir of dirs) {
    if (!existsSync(dir) || !statSync(dir).isDirectory()) continue;
    walk(dir, 0);
  }
  return runs.sort((a, b) => (a.startedAt ?? "").localeCompare(b.startedAt ?? "") || a.runId.localeCompare(b.runId));
}

// ── baselines ────────────────────────────────────────────────────────────────

const TAG = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export interface BaselineTag {
  readonly version: 1;
  readonly name: string;
  readonly createdAt: string;
  /** The result files it was tagged from (evidence; the runs below are a snapshot of them). */
  readonly sources: readonly string[];
  /** Snapshot of the tagged runs' findings, so a baseline survives its result files being pruned. */
  readonly runs: readonly RunRecord[];
}

function tagPath(dir: string, name: string): string {
  if (!TAG.test(name)) throw new ReportInputError(`invalid baseline tag ${JSON.stringify(name)}: must match [A-Za-z0-9][A-Za-z0-9._-]*`);
  return join(dir, `${name}.json`);
}

export async function tagBaseline(opts: {
  name: string;
  runs: readonly RunRecord[];
  dir?: string;
  nowIso?: () => string;
}): Promise<{ tag: BaselineTag; path: string }> {
  const dir = opts.dir ?? defaultBaselinesDir();
  const path = tagPath(dir, opts.name);
  if (opts.runs.length === 0) throw new ReportInputError("a baseline needs at least one run");
  const tag: BaselineTag = {
    version: 1,
    name: opts.name,
    createdAt: (opts.nowIso ?? (() => clock.nowIso()))(),
    sources: opts.runs.map((r) => r.path),
    runs: opts.runs,
  };
  await mkdir(dir, { recursive: true });
  await writeFile(path, `${JSON.stringify(tag, null, 2)}\n`, "utf8");
  return { tag, path };
}

export function readBaseline(name: string, dir: string = defaultBaselinesDir()): BaselineTag | null {
  if (!TAG.test(name)) return null;
  const path = join(dir, `${name}.json`);
  if (!existsSync(path)) return null;
  let raw: unknown;
  try {
    raw = readJson(path);
  } catch (e) {
    throw new ReportInputError(`cannot read baseline ${path}: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!isRecord(raw) || raw.version !== 1 || !Array.isArray(raw.runs)) throw new ReportInputError(`not a baseline tag: ${path}`);
  return raw as unknown as BaselineTag;
}

export async function listBaselines(dir: string = defaultBaselinesDir()): Promise<Array<{ name: string; createdAt: string; runs: number }>> {
  if (!existsSync(dir)) return [];
  const out: Array<{ name: string; createdAt: string; runs: number }> = [];
  for (const f of (await readdir(dir)).sort()) {
    if (!f.endsWith(".json")) continue;
    const tag = readBaseline(f.slice(0, -".json".length), dir);
    if (tag !== null) out.push({ name: tag.name, createdAt: tag.createdAt, runs: tag.runs.length });
  }
  return out;
}

// ── run references ───────────────────────────────────────────────────────────

export interface RunRefContext {
  readonly dirs: readonly string[];
  readonly baselinesDir?: string;
}

/** A `jevitate check` record: `{ kind: "jevitate-check", results: [paths] }` (or its envelope). */
function checkRecordResults(raw: unknown): string[] | null {
  const data = isRecord(raw) && isRecord(raw.data) ? raw.data : raw;
  if (!isRecord(data) || data.kind !== "jevitate-check" || !Array.isArray(data.results)) return null;
  return data.results.filter((p): p is string => typeof p === "string");
}

/** Resolves one `<run>` reference to its runs (a check record or a baseline tag names several). */
export function resolveRunRef(ref: string, ctx: RunRefContext): RunRecord[] {
  if (existsSync(ref) && statSync(ref).isFile()) {
    const path = resolve(ref);
    let raw: unknown;
    try {
      raw = readJson(path);
    } catch (e) {
      throw new ReportInputError(`cannot read ${ref}: ${e instanceof Error ? e.message : String(e)}`);
    }
    const listed = checkRecordResults(raw);
    if (listed !== null) {
      return listed.map((p) => resolve(dirname(path), p)).flatMap((p) => {
        const run = loadRunFile(p);
        if (run === null) throw new ReportInputError(`${ref} lists ${p}, which is not a readable result`);
        return [run];
      });
    }
    const run = loadRunFile(path);
    if (run === null) throw new ReportInputError(`${ref} is not a mission result, usability report or check record`);
    return [run];
  }
  const tag = readBaseline(ref, ctx.baselinesDir);
  // #171: a tag snapshotted before runs carried their scope re-reads it from the result file, when
  // that still exists (otherwise the run compares by mode and target only).
  if (tag !== null) return tag.runs.map((r) => (r.scope === undefined && existsSync(r.path) ? (loadRunFile(r.path) ?? r) : r));
  const id = runIdOf(ref);
  for (const dir of ctx.dirs) {
    for (const candidate of [join(dir, `${id}.result.json`), join(dir, `${id}.json`)]) {
      if (!existsSync(candidate)) continue;
      const run = loadRunFile(candidate);
      if (run !== null) return [run];
    }
  }
  throw new ReportInputError(`no run, baseline tag or result file named ${JSON.stringify(ref)} (searched ${ctx.dirs.join(", ")})`);
}

export function resolveRunRefs(refs: readonly string[], ctx: RunRefContext): RunRecord[] {
  const byPath = new Map<string, RunRecord>();
  for (const ref of refs) for (const r of resolveRunRef(ref, ctx)) byPath.set(`${r.path}#${r.runId}`, r);
  return [...byPath.values()];
}

/**
 * `last`: for every (target, mode) the current runs cover, the most recent EARLIER run of that
 * target and mode in `pool` — "the last run on this target", per mode.
 */
export function lastRunsBefore(current: readonly RunRecord[], pool: readonly RunRecord[]): RunRecord[] {
  const currentIds = new Set(current.map((r) => r.path));
  const out = new Map<string, RunRecord>();
  const pairs = new Map<string, string>();
  for (const r of current) {
    const k = `${r.target ?? ""}|${r.mode}`;
    const t = r.startedAt ?? "";
    const prev = pairs.get(k);
    if (prev === undefined || t < prev) pairs.set(k, t);
  }
  for (const r of pool) {
    if (currentIds.has(r.path)) continue;
    const k = `${r.target ?? ""}|${r.mode}`;
    const before = pairs.get(k);
    if (before === undefined || (r.startedAt ?? "") >= before) continue;
    const prev = out.get(k);
    if (prev === undefined || (prev.startedAt ?? "") < (r.startedAt ?? "")) out.set(k, r);
  }
  return [...out.values()];
}

/** Resolves `--baseline <run|tag|last>` against the current runs. */
export function resolveBaseline(ref: string, current: readonly RunRecord[], ctx: RunRefContext & { pool?: readonly RunRecord[] }): RunRecord[] {
  if (ref === "last") return lastRunsBefore(current, ctx.pool ?? scanRuns(ctx.dirs));
  return resolveRunRef(ref, ctx);
}

// ── targets ──────────────────────────────────────────────────────────────────

/**
 * `--target <origin|name>`: an origin (or any URL on it), or a name — a suite target name stamped
 * on results by `jevitate check`, or a registered mission target (`~/.jevitate/missions/targets`).
 */
export async function resolveTargetFilter(
  target: string,
  missionTargetsDir: string,
): Promise<{ origins: string[]; name: string }> {
  try {
    return { origins: [new URL(target).origin], name: target };
  } catch {
    // not a URL: a name
  }
  const origins: string[] = [];
  if (existsSync(missionTargetsDir)) {
    for (const f of await readdir(missionTargetsDir)) {
      if (!f.endsWith(".json")) continue;
      try {
        const t = JSON.parse(await readFile(join(missionTargetsDir, f), "utf8")) as unknown;
        if (isRecord(t) && (t.id === target || t.name === target) && typeof t.authorizedOrigin === "string") {
          origins.push(new URL(t.authorizedOrigin).origin);
        }
      } catch {
        continue; // a corrupt target file names nothing
      }
    }
  }
  return { origins, name: target };
}

/** `--since <run|date>`: an ISO date/time, or a run reference whose start time is the cut-off. */
export function resolveSince(since: string, ctx: RunRefContext): string {
  if (/^\d{4}-\d{2}-\d{2}/.test(since) && !Number.isNaN(Date.parse(since))) return new Date(Date.parse(since)).toISOString();
  const runs = resolveRunRef(since, ctx);
  const times = runs.map((r) => r.startedAt).filter((t): t is string => t !== undefined).sort();
  if (times[0] === undefined) throw new ReportInputError(`--since ${since}: that run has no start time`);
  return times[0];
}

// ── report ───────────────────────────────────────────────────────────────────

export interface BuildReportOptions {
  readonly target?: string;
  readonly since?: string;
  /** #426: `--tag key=value` filters — only runs carrying EVERY one (AND). */
  readonly tags?: Readonly<Record<string, string>>;
  readonly dirs?: readonly string[];
  readonly baseline?: string;
  readonly baselinesDir?: string;
  readonly missionTargetsDir: string;
  /** Explicit runs (e.g. `jevitate check`'s own results) instead of scanning `dirs`. */
  readonly runs?: readonly RunRecord[];
  /** #213: the project/run-index seam (cwd, home, index file) for the default sources. */
  readonly index?: RunIndexDeps;
}

export interface RunSummary {
  readonly runId: string;
  readonly mode: string;
  readonly path: string;
  readonly target?: string;
  readonly startedAt?: string;
  readonly missionOutcome?: string;
  /** #217: a goal run's own ending, beside the canonical `missionOutcome`. */
  readonly goalOutcome?: string;
  readonly targetBuild?: string;
  readonly engineCommit?: string;
  readonly findings: number;
  /** #426: the run's tags. */
  readonly tags?: Readonly<Record<string, string>>;
}

export interface ReportResult {
  readonly target?: string;
  readonly since?: string;
  /** #426: the tag filter the report was narrowed to. */
  readonly tags?: Readonly<Record<string, string>>;
  readonly runs: readonly RunSummary[];
  readonly defects: readonly ConsolidatedDefect[];
  readonly summary: { readonly defects: number; readonly advisory: number; readonly runs: number };
  /**
   * Model usage summed over the reported runs (#163). Runs whose result carries no `usage` (they made
   * no model call, or predate usage accounting) are counted in `unreportedRuns`, not priced.
   */
  readonly usage: UsageAggregate;
  readonly diff?: FindingsDiff;
  readonly baselineRuns?: readonly RunSummary[];
  readonly markdown: string;
}

export function summarizeRun(r: RunRecord): RunSummary {
  return {
    runId: r.runId,
    mode: r.mode,
    path: r.path,
    findings: r.observations.length,
    ...(r.target === undefined ? {} : { target: r.target }),
    ...(r.startedAt === undefined ? {} : { startedAt: r.startedAt }),
    ...(r.missionOutcome === undefined ? {} : { missionOutcome: r.missionOutcome }),
    ...(r.goalOutcome === undefined ? {} : { goalOutcome: r.goalOutcome }),
    ...(r.targetBuild === undefined ? {} : { targetBuild: r.targetBuild }),
    ...(r.engine?.commit === undefined ? {} : { engineCommit: r.engine.commit }),
    ...(r.tags === undefined ? {} : { tags: r.tags }),
  };
}

/** #426: the runs carrying every filter tag (AND); no filter keeps them all. */
export function filterRunsByTags<R extends { readonly tags?: Readonly<Record<string, string>> }>(runs: readonly R[], tags: Readonly<Record<string, string>> | undefined): R[] {
  if (tags === undefined || Object.keys(tags).length === 0) return [...runs];
  return runs.filter((r) => matchesRunTags(r.tags ?? {}, tags));
}

function tagsLabel(tags: Readonly<Record<string, string>>): string {
  return Object.entries(tags)
    .map(([k, v]) => `${k}=${v}`)
    .join(", ");
}

export async function buildReport(opts: BuildReportOptions): Promise<ReportResult> {
  const explicitDirs = opts.dirs !== undefined && opts.dirs.length > 0;
  const sources = explicitDirs ? { dirs: [...opts.dirs!], files: [] } : defaultReportSources(opts.target !== undefined, opts.index);
  const dirs = sources.dirs;
  const ctx: RunRefContext = { dirs: [...dirs, ...parentDirs(sources.files)], ...(opts.baselinesDir === undefined ? {} : { baselinesDir: opts.baselinesDir }) };
  const scanPool = (): RunRecord[] => withFiles(scanRuns(dirs), sources.files);
  const pool = opts.runs ?? scanPool();
  let runs = [...pool];
  let targetLabel: string | undefined;
  if (opts.target !== undefined) {
    const t = await resolveTargetFilter(opts.target, opts.missionTargetsDir);
    targetLabel = t.origins.length > 0 ? t.origins.join(", ") : t.name;
    runs = runs.filter((r) => (r.target !== undefined && t.origins.includes(r.target)) || r.targetName === t.name);
    // #213: a target no run was ever recorded for is refused (exit 64), naming the known ones — never
    // an empty report that reads like "nothing wrong".
    if (runs.length === 0 && opts.runs === undefined) {
      const known = await knownTargets(pool, opts.missionTargetsDir);
      throw new ReportInputError(
        `--target ${JSON.stringify(opts.target)} matches no recorded run${known.length === 0 ? " (no runs found at all)" : `; known targets: ${known.join(", ")}`}`,
      );
    }
  }
  const since = opts.since === undefined ? undefined : resolveSince(opts.since, ctx);
  if (since !== undefined) runs = runs.filter((r) => r.startedAt !== undefined && r.startedAt >= since);
  const tagFilter = opts.tags !== undefined && Object.keys(opts.tags).length > 0 ? opts.tags : undefined;
  runs = filterRunsByTags(runs, tagFilter);
  // #426: like --target, a tag no run carries is refused (exit 64) — never an empty "nothing wrong" report.
  if (tagFilter !== undefined && runs.length === 0 && opts.runs === undefined) {
    throw new ReportInputError(`--tag ${tagsLabel(tagFilter)} matches no recorded run`);
  }
  const defects = consolidate(runs);
  let diff: FindingsDiff | undefined;
  let baselineRuns: RunRecord[] | undefined;
  if (opts.baseline !== undefined) {
    baselineRuns = resolveBaseline(opts.baseline, runs, { ...ctx, pool: opts.runs === undefined ? pool : scanPool() });
    diff = diffRuns(baselineRuns, runs);
  }
  const usage = usageOfRuns(runs);
  const markdown =
    renderReportMarkdown({
      title: `Defect report${targetLabel === undefined ? "" : ` — ${targetLabel}`}${since === undefined ? "" : ` since ${since}`}${tagFilter === undefined ? "" : ` tagged ${tagsLabel(tagFilter)}`}`,
      runs,
      defects,
      ...(diff === undefined ? {} : { diff }),
    }) + usageMarkdown(usage);
  return {
    ...(targetLabel === undefined ? {} : { target: targetLabel }),
    ...(since === undefined ? {} : { since }),
    ...(tagFilter === undefined ? {} : { tags: tagFilter }),
    runs: runs.map(summarizeRun),
    defects,
    summary: {
      defects: defects.filter((d) => d.severity === "hard").length,
      advisory: defects.filter((d) => d.severity === "advisory").length,
      runs: runs.length,
    },
    usage,
    ...(diff === undefined ? {} : { diff }),
    ...(baselineRuns === undefined ? {} : { baselineRuns: baselineRuns.map(summarizeRun) }),
    markdown,
  };
}

/** Sums the runs' persisted usage (#163). */
export function usageOfRuns(runs: readonly RunRecord[]): UsageAggregate {
  return sumUsage(
    runs.map((r) => usageCountsFrom(r.usage)),
    { unreported: "ignore" },
  );
}

/** The report's cost section: the full total, flagged when partial. */
export function usageMarkdown(u: UsageAggregate): string {
  if (u.judgments + u.generations === 0) return "";
  const unreported = u.unreportedRuns === undefined ? "" : ` (${u.unreportedRuns} run(s) carried no usage)`;
  return `\n## Model cost\n\n${formatUsageLine(u)} over ${u.runs} run(s)${unreported}\n`;
}

/** `jevitate diff <runA> <runB>`: A is the baseline side, B the current side. */
export function diffRunRefs(
  a: string,
  b: string,
  ctx: RunRefContext & { readonly tags?: Readonly<Record<string, string>> },
): { diff: FindingsDiff; markdown: string; baseline: RunSummary[]; current: RunSummary[] } {
  // #426: `--tag` narrows BOTH sides (a baseline tag or a dir holds runs of many features).
  const base = filterRunsByTags(resolveRunRef(a, ctx), ctx.tags);
  const cur = filterRunsByTags(resolveRunRef(b, ctx), ctx.tags);
  if (ctx.tags !== undefined && Object.keys(ctx.tags).length > 0 && (base.length === 0 || cur.length === 0)) {
    throw new ReportInputError(`--tag ${tagsLabel(ctx.tags)} matches no run of ${base.length === 0 ? a : b}`);
  }
  const diff = diffRuns(base, cur);
  const markdown = renderReportMarkdown({ title: `Diff ${a} → ${b}`, runs: cur, defects: consolidate(cur), diff });
  return { diff, markdown, baseline: base.map(summarizeRun), current: cur.map(summarizeRun) };
}
