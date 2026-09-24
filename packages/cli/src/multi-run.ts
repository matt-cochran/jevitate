import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { MISSION_EXIT_CODES } from "@jevitate/domain";
import { normalizeRoute } from "@jevitate/explore";

/**
 * Multi-run orchestration over the existing explore strategies (#141 repeat-and-vote, #143 persona
 * matrix). One orchestrator runs the SAME mission N times — once per persona (storageState) and
 * `--repeat` times within each — strictly SEQUENTIALLY (never concurrently: conversational and
 * stateful missions share server-side state), each run in a fresh browser context (every run is a
 * separate mission, which opens its own context). It then aggregates the runs with code only:
 *
 *  - repeat-and-vote (#141): a finding is kept when it recurs in ≥ k of N runs; the rest are
 *    reported as `flaky` (seen, not counted). The overall outcome is the agreed one (the most
 *    common per-run outcome, when it was reached by ≥ k runs), else `intermittent`.
 *  - persona matrix (#143): per-persona outcome, findings, requests (method + templated path →
 *    status) and visible controls, plus an ADVISORY diff: requests one persona made that another
 *    did not, status differences for the same request (a 401/403 against a 2xx is a candidate RBAC
 *    finding), controls visible to one persona only, and each persona's outcome.
 *
 * Storage-state CONTENTS are never read, logged or copied here — only their paths travel.
 */

// ---------- plan (flags) ----------

export class MultiRunArgsError extends Error {
  readonly code = "E_EXPLORE_ARGS" as const;
  constructor(message: string) {
    super(message);
    this.name = "MultiRunArgsError";
  }
}

export interface Persona {
  readonly name: string;
  /** Absolute path of the persona's Playwright storageState file (its contents are never read). */
  readonly storageState: string;
}

export interface MultiRunPlan {
  /** Runs per persona (or per mission, without personas). */
  readonly repeat: number;
  /** A finding (and the outcome) counts when seen in at least this many of `repeat` runs. */
  readonly minAgreement: number;
  /** The persona matrix; `null` for a plain `--repeat`. */
  readonly personas: readonly Persona[] | null;
}

/** Upper bound on `--repeat`: each run is a whole mission, run one after another. */
export const MAX_REPEAT = 20;
const PERSONA_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

function persona(name: string, storageState: string, base: string, noun = "persona"): Persona {
  if (!PERSONA_NAME.test(name)) {
    throw new MultiRunArgsError(`${noun} name ${JSON.stringify(name)} must be 1-64 of [A-Za-z0-9_.-], starting alphanumeric`);
  }
  if (storageState.trim() === "") throw new MultiRunArgsError(`${noun} ${name}: storage state path is empty`);
  const path = isAbsolute(storageState) ? storageState : resolve(base, storageState);
  if (!existsSync(path)) throw new MultiRunArgsError(`${noun} ${name}: storage state not found: ${path}`);
  return { name, storageState: path };
}

/** `--persona <name>=<storageState>`: the path is resolved against the working directory. */
export function parsePersonaSpec(spec: string, cwd: string = process.cwd()): Persona {
  const eq = spec.indexOf("=");
  if (eq <= 0) throw new MultiRunArgsError(`--persona must be <name>=<storageState>, got ${JSON.stringify(spec)}`);
  return persona(spec.slice(0, eq), spec.slice(eq + 1), cwd);
}

/**
 * `--actor <name>=<storageState>` (#147): the same `<name>=<storageState>` shape and checks as a
 * persona (the file must exist; its contents are never read here).
 */
export function parseActorSpec(spec: string, cwd: string = process.cwd()): Persona {
  const eq = spec.indexOf("=");
  if (eq <= 0) throw new MultiRunArgsError(`--actor must be <name>=<storageState>, got ${JSON.stringify(spec)}`);
  return persona(spec.slice(0, eq), spec.slice(eq + 1), cwd, "actor");
}

/**
 * `--personas <file>`: JSON, either `{"admin": "admin.json", "sales": "sales.json"}` or
 * `{"personas": [{"name": "admin", "storageState": "admin.json"}]}` (a bare array also works).
 * Relative paths resolve against the personas file's own directory.
 */
export function loadPersonasFile(path: string): Persona[] {
  if (!existsSync(path)) throw new MultiRunArgsError(`personas file not found: ${path}`);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new MultiRunArgsError(`personas file ${path} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  const base = dirname(resolve(path));
  const list = Array.isArray(raw) ? raw : isRecord(raw) && Array.isArray(raw.personas) ? raw.personas : null;
  if (list !== null) {
    return list.map((p, i) => {
      if (!isRecord(p) || typeof p.name !== "string" || typeof p.storageState !== "string") {
        throw new MultiRunArgsError(`personas file ${path}: entry ${i} must be {"name": string, "storageState": string}`);
      }
      return persona(p.name, p.storageState, base);
    });
  }
  if (isRecord(raw)) {
    return Object.entries(raw).map(([name, state]) => {
      if (typeof state !== "string") throw new MultiRunArgsError(`personas file ${path}: ${name} must map to a storage state path`);
      return persona(name, state, base);
    });
  }
  throw new MultiRunArgsError(`personas file ${path} must be an object or an array of personas`);
}

export interface MultiRunFlags {
  readonly repeat?: string;
  readonly minAgreement?: string;
  readonly persona: readonly string[];
  readonly personas?: string;
  readonly storageState?: string;
  readonly saveStorageState?: string;
}

/** Whether the flags ask for a multi-run at all. */
export function wantsMultiRun(f: MultiRunFlags): boolean {
  return f.repeat !== undefined || f.minAgreement !== undefined || f.persona.length > 0 || f.personas !== undefined;
}

function positiveInt(v: string, flag: string): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw new MultiRunArgsError(`${flag} must be a positive integer, got ${JSON.stringify(v)}`);
  return n;
}

/** Validates the multi-run flags (before any browser opens). Default k = a strict majority of N. */
export function resolveMultiRunPlan(f: MultiRunFlags, cwd: string = process.cwd()): MultiRunPlan {
  const repeat = f.repeat === undefined ? 1 : positiveInt(f.repeat, "--repeat");
  if (repeat > MAX_REPEAT) throw new MultiRunArgsError(`--repeat must be at most ${MAX_REPEAT}, got ${repeat}`);
  const minAgreement = f.minAgreement === undefined ? Math.floor(repeat / 2) + 1 : positiveInt(f.minAgreement, "--min-agreement");
  if (minAgreement > repeat) throw new MultiRunArgsError(`--min-agreement (${minAgreement}) cannot exceed --repeat (${repeat})`);
  const personas = [...f.persona.map((s) => parsePersonaSpec(s, cwd)), ...(f.personas === undefined ? [] : loadPersonasFile(f.personas))];
  if (personas.length > 0) {
    if (f.storageState !== undefined) {
      throw new MultiRunArgsError("--storage-state cannot be combined with --persona/--personas (each persona brings its own)");
    }
    if (f.saveStorageState !== undefined) {
      throw new MultiRunArgsError("--save-storage-state cannot be combined with --persona/--personas (one file cannot hold every persona)");
    }
    const seen = new Set<string>();
    for (const p of personas) {
      if (seen.has(p.name)) throw new MultiRunArgsError(`persona ${p.name} is declared twice`);
      seen.add(p.name);
    }
  }
  return { repeat, minAgreement, personas: personas.length > 0 ? personas : null };
}

// ---------- per-run extraction (pure) ----------

/** One finding as a run reported it, reduced to what cross-run matching needs. */
export interface RunFinding {
  /** defect / invariant / hang / advisory / coverage-defect / ux (plus the defect's own kind). */
  readonly kind: string;
  /** The engine's own stable fingerprint, when the finding has one. */
  readonly fingerprint?: string;
  /** Templated route it was (first) seen on. */
  readonly route: string;
  readonly title: string;
  /** For a UX finding: its rubric item and implicated controls (a UX finding has no fingerprint). */
  readonly rubricItemId?: string;
  readonly controls?: readonly string[];
}

/**
 * THE cross-run finding identity (#141). Kept deliberately small and self-contained so it can be
 * swapped for the shared finding-identity model of `jevitate report`/`diff`/`check` (#137–#139):
 * the engine's own fingerprint (defect / hang / invariant / signal) plus the templated route; a UX
 * finding (no fingerprint) is its rubric item + route + implicated controls.
 */
export function findingIdentity(f: RunFinding): string {
  const route = normalizeRoute(f.route);
  if (f.fingerprint !== undefined) return `${f.kind}:${f.fingerprint}@${route}`;
  return `${f.kind}:${f.rubricItemId ?? f.title}@${route}[${[...(f.controls ?? [])].sort().join("|")}]`;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function str(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

function routeOf(item: Record<string, unknown>): string {
  if (typeof item.route === "string") return item.route;
  if (typeof item.url === "string") return normalizeRoute(item.url);
  return "/";
}

/** Every finding a run's result carries, whatever its strategy. */
export function extractRunFindings(data: unknown): RunFinding[] {
  if (!isRecord(data)) return [];
  const out: RunFinding[] = [];
  const fingerprinted = (list: unknown, kindOf: (item: Record<string, unknown>) => string): void => {
    if (!Array.isArray(list)) return;
    for (const item of list) {
      if (!isRecord(item) || typeof item.fingerprint !== "string") continue;
      out.push({ kind: kindOf(item), fingerprint: item.fingerprint, route: routeOf(item), title: str(item.title, item.fingerprint) });
    }
  };
  // Adversarial defects (hard signals + invariants), declared-invariant defects, hangs, advisories.
  fingerprinted(data.defects, (d) => (d.kind === "invariant" ? "invariant" : `defect/${str(d.kind, "unknown")}`));
  fingerprinted(data.hangs, () => "hang");
  fingerprinted(data.advisories, (a) => `advisory/${str(a.kind, "signal")}`);
  // Coverage: states the looksBroken judgment flagged, keyed by their state fingerprint.
  if (isRecord(data.coverage) && Array.isArray(data.coverage.defects)) {
    for (const d of data.coverage.defects) {
      if (!isRecord(d) || typeof d.stateFingerprint !== "string") continue;
      out.push({ kind: "coverage-defect", fingerprint: d.stateFingerprint, route: routeOf(d), title: str(d.reason, "looks broken") });
    }
  }
  // Usability: UX findings (advisory) — identity by rubric item, route and implicated controls.
  if (isRecord(data.report) && Array.isArray(data.report.findings)) {
    for (const f of data.report.findings) {
      if (!isRecord(f) || typeof f.rubricItemId !== "string") continue;
      const controls = Array.isArray(f.controls) ? f.controls.filter((c): c is string => typeof c === "string") : [];
      out.push({ kind: "ux", route: routeOf(f), title: str(f.observation, f.rubricItemId), rubricItemId: f.rubricItemId, controls });
    }
  }
  return out;
}

/**
 * A run's outcome for voting: the goal strategy's own `outcome` (succeeded / exhausted / blocked /
 * …), else the canonical `missionOutcome` (adversarial's `outcome` already is one).
 */
export function runOutcomeOf(strategy: string, data: unknown): string {
  if (!isRecord(data)) return "crashed";
  if (strategy === "goal" && typeof data.outcome === "string") return data.outcome;
  if (typeof data.missionOutcome === "string") return data.missionOutcome;
  if (typeof data.outcome === "string") return data.outcome;
  return "crashed";
}

/** `METHOD /templated/path` → the distinct response statuses seen (assets excluded; pending dropped). */
export function extractRequests(data: unknown): Record<string, number[]> {
  const out: Record<string, number[]> = {};
  if (!isRecord(data) || !isRecord(data.timing) || !isRecord(data.timing.endpoints)) return out;
  for (const [endpoint, stat] of Object.entries(data.timing.endpoints)) {
    if (!isRecord(stat) || stat.kind === "asset") continue;
    const statuses = Array.isArray(stat.statuses) ? stat.statuses.filter((s): s is number => typeof s === "number") : [];
    out[endpoint] = [...new Set(statuses)].sort((a, b) => a - b);
  }
  return out;
}

/** Every control identity the run's transcript saw (see `TranscriptEntry.controls`). */
export function extractControls(transcript: unknown): string[] {
  const seen = new Set<string>();
  if (!Array.isArray(transcript)) return [];
  for (const e of transcript) {
    if (!isRecord(e) || !Array.isArray(e.controls)) continue;
    for (const c of e.controls) if (typeof c === "string") seen.add(c);
  }
  return [...seen].sort();
}

// ---------- aggregation (pure) ----------

/** What one run contributed. */
export interface RunSummary {
  /** 1-based, within its persona. */
  readonly index: number;
  /** False when the run could not start or broke outside the mission (its envelope was an error). */
  readonly ok: boolean;
  readonly outcome: string;
  readonly exitCode: number;
  readonly findings: readonly RunFinding[];
  readonly requests: Readonly<Record<string, readonly number[]>>;
  readonly controls: readonly string[];
  /** The run's own persisted result (or report), when it wrote one. */
  readonly resultPath?: string;
  /** The run's envelope, as written next to its artifacts. */
  readonly envelopePath?: string;
  readonly error?: { readonly code: string; readonly message: string };
}

export interface AggregatedFinding {
  readonly id: string;
  readonly kind: string;
  readonly fingerprint?: string;
  readonly route: string;
  readonly title: string;
  /** `seen/N`, e.g. `2/3`. */
  readonly stability: string;
  readonly seen: number;
  readonly of: number;
  /** Which runs (1-based) saw it. */
  readonly runs: number[];
  /** `agreed`: seen in ≥ k runs (counted). `flaky`: seen in fewer — reported, never counted. */
  readonly status: "agreed" | "flaky";
}

export interface CellResult {
  readonly persona: string | null;
  readonly storageStatePath?: string;
  /** The agreed outcome, or `intermittent` when no outcome reached k runs (or tied). */
  readonly outcome: string;
  readonly exitCode: number;
  /** How many runs ended in each outcome. */
  readonly outcomes: Readonly<Record<string, number>>;
  readonly runs: readonly RunSummary[];
  /** Agreed findings (≥ k runs), most stable first. */
  readonly findings: AggregatedFinding[];
  /** Findings seen in fewer than k runs. */
  readonly flaky: AggregatedFinding[];
  /** Requests seen in ≥ k runs → every status seen for them. */
  readonly requests: Record<string, number[]>;
  /** Controls seen in ≥ k runs. */
  readonly controls: string[];
}

/** Exit code for an agreed outcome: taken from a run that reached it (strategies differ); intermittent → 4. */
function exitCodeFor(outcome: string, runs: readonly RunSummary[]): number {
  if (outcome === "intermittent") return MISSION_EXIT_CODES.intermittent;
  return runs.find((r) => r.outcome === outcome)?.exitCode ?? MISSION_EXIT_CODES.inconclusive;
}

/** Votes one persona's (or the mission's) N runs: findings, outcome, requests and controls. */
export function voteRuns(runs: readonly RunSummary[], k: number, persona: Persona | null = null): CellResult {
  const n = runs.length;
  const outcomes: Record<string, number> = {};
  for (const r of runs) outcomes[r.outcome] = (outcomes[r.outcome] ?? 0) + 1;
  const ranked = Object.entries(outcomes).sort((a, b) => b[1] - a[1]);
  const top = ranked[0];
  const tied = ranked[1] !== undefined && top !== undefined && ranked[1][1] === top[1];
  const outcome = top !== undefined && top[1] >= k && !tied ? top[0] : "intermittent";

  const byId = new Map<string, { f: RunFinding; runs: number[] }>();
  for (const r of runs) {
    for (const f of r.findings) {
      const id = findingIdentity(f);
      const cur = byId.get(id) ?? { f, runs: [] };
      if (!cur.runs.includes(r.index)) cur.runs.push(r.index);
      byId.set(id, cur);
    }
  }
  const all: AggregatedFinding[] = [...byId.entries()].map(([id, { f, runs: seenIn }]) => ({
    id,
    kind: f.kind,
    ...(f.fingerprint === undefined ? {} : { fingerprint: f.fingerprint }),
    route: normalizeRoute(f.route),
    title: f.title,
    stability: `${seenIn.length}/${n}`,
    seen: seenIn.length,
    of: n,
    runs: seenIn.sort((a, b) => a - b),
    status: seenIn.length >= k ? "agreed" : "flaky",
  }));
  all.sort((a, b) => b.seen - a.seen || a.id.localeCompare(b.id));

  const requestRuns = new Map<string, { runs: number; statuses: Set<number> }>();
  const controlRuns = new Map<string, number>();
  for (const r of runs) {
    for (const [endpoint, statuses] of Object.entries(r.requests)) {
      const cur = requestRuns.get(endpoint) ?? { runs: 0, statuses: new Set<number>() };
      cur.runs += 1;
      for (const s of statuses) cur.statuses.add(s);
      requestRuns.set(endpoint, cur);
    }
    for (const c of new Set(r.controls)) controlRuns.set(c, (controlRuns.get(c) ?? 0) + 1);
  }
  const requests: Record<string, number[]> = {};
  for (const [endpoint, v] of [...requestRuns.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (v.runs >= k) requests[endpoint] = [...v.statuses].sort((a, b) => a - b);
  }
  const controls = [...controlRuns.entries()].filter(([, c]) => c >= k).map(([c]) => c).sort();

  return {
    persona: persona?.name ?? null,
    ...(persona === null ? {} : { storageStatePath: persona.storageState }),
    outcome,
    exitCode: exitCodeFor(outcome, runs),
    outcomes,
    runs,
    findings: all.filter((f) => f.status === "agreed"),
    flaky: all.filter((f) => f.status === "flaky"),
    requests,
    controls,
  };
}

export interface PersonaPresenceDiff {
  /** The request (`METHOD /templated/path`) or control (`role "name"`). */
  readonly item: string;
  /** Personas that made / saw it. */
  readonly presentFor: string[];
  /** Personas that did not. */
  readonly absentFor: string[];
}

export interface PersonaStatusDiff {
  readonly request: string;
  /** Persona → the statuses its runs got for this same request. */
  readonly statuses: Record<string, number[]>;
}

export interface RbacCandidate {
  readonly request: string;
  /** Personas refused (401/403) and the status they got. */
  readonly denied: Record<string, number[]>;
  /** Personas the same request succeeded (2xx) for. */
  readonly allowed: string[];
  readonly title: string;
}

export interface PersonaDiff {
  /** Always true: the diff is code-computed evidence for a person to judge, never a verdict. */
  readonly advisory: true;
  readonly requestsOnlyIn: PersonaPresenceDiff[];
  readonly statusDiffs: PersonaStatusDiff[];
  readonly controlsOnlyIn: PersonaPresenceDiff[];
  /** Persona → its agreed outcome. */
  readonly outcomes: Record<string, string>;
  /** True when not every persona reached the same outcome. */
  readonly outcomeDiffers: boolean;
  /** A 401/403 for one persona where another got a 2xx on the same request. */
  readonly rbacCandidates: RbacCandidate[];
}

const is2xx = (s: number): boolean => s >= 200 && s < 300;
const isDenied = (s: number): boolean => s === 401 || s === 403;

function presence(sets: ReadonlyMap<string, ReadonlySet<string>>): PersonaPresenceDiff[] {
  const names = [...sets.keys()];
  const items = new Set<string>();
  for (const s of sets.values()) for (const i of s) items.add(i);
  const out: PersonaPresenceDiff[] = [];
  for (const item of [...items].sort()) {
    const presentFor = names.filter((n) => sets.get(n)?.has(item) === true);
    if (presentFor.length === names.length) continue;
    out.push({ item, presentFor, absentFor: names.filter((n) => !presentFor.includes(n)) });
  }
  return out;
}

/** The persona matrix's diff section (#143): pure, over the per-persona (voted) cells. */
export function diffPersonas(cells: readonly CellResult[]): PersonaDiff {
  const named = cells.filter((c): c is CellResult & { persona: string } => c.persona !== null);
  const requestSets = new Map(named.map((c) => [c.persona, new Set(Object.keys(c.requests))] as const));
  const controlSets = new Map(named.map((c) => [c.persona, new Set(c.controls)] as const));

  const statusDiffs: PersonaStatusDiff[] = [];
  const rbacCandidates: RbacCandidate[] = [];
  const shared = new Set<string>();
  for (const c of named) for (const r of Object.keys(c.requests)) shared.add(r);
  for (const request of [...shared].sort()) {
    const having = named.filter((c) => c.requests[request] !== undefined && c.requests[request]!.length > 0);
    if (having.length < 2) continue;
    const key = (c: CellResult): string => (c.requests[request] ?? []).join(",");
    if (new Set(having.map(key)).size < 2) continue;
    const statuses: Record<string, number[]> = {};
    for (const c of having) statuses[c.persona] = [...(c.requests[request] ?? [])];
    statusDiffs.push({ request, statuses });
    const denied: Record<string, number[]> = {};
    const allowed: string[] = [];
    for (const c of having) {
      const ss = c.requests[request] ?? [];
      if (ss.some(is2xx)) allowed.push(c.persona);
      else if (ss.some(isDenied)) denied[c.persona] = ss.filter(isDenied);
    }
    if (allowed.length > 0 && Object.keys(denied).length > 0) {
      const deniedText = Object.entries(denied)
        .map(([p, ss]) => `${ss.join("/")} for ${p}`)
        .join(", ");
      rbacCandidates.push({ request, denied, allowed, title: `${request}: ${deniedText}; 2xx for ${allowed.join(", ")}` });
    }
  }
  const outcomes: Record<string, string> = {};
  for (const c of named) outcomes[c.persona] = c.outcome;
  return {
    advisory: true,
    requestsOnlyIn: presence(requestSets),
    statusDiffs,
    controlsOnlyIn: presence(controlSets),
    outcomes,
    outcomeDiffers: new Set(Object.values(outcomes)).size > 1,
    rbacCandidates,
  };
}

// ---------- orchestration ----------

/** A run's JSON envelope, exactly as `jevitate explore --json` emits it. */
export type RunEnvelope =
  | { readonly ok: true; readonly data: unknown }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } };

export interface RunOnceArgs {
  /** Persona storage state to start from (`undefined`: the mission's own `--storage-state`, if any). */
  readonly storageState?: string;
  /** Where this run writes its artifacts. */
  readonly outDir: string;
}

export type RunOnce = (args: RunOnceArgs) => Promise<RunEnvelope>;

export interface MultiRunResult {
  readonly kind: "multi-run";
  readonly strategy: string;
  readonly repeat: number;
  readonly minAgreement: number;
  /** Without personas: the agreed outcome. With personas: every persona's, when they agree; else `mixed`. */
  readonly outcome: string;
  /** Without personas: the agreed outcome's code. With personas: the highest persona code. */
  readonly exitCode: number;
  /** Agreed findings (with personas: each tagged by persona). */
  readonly findings: Array<AggregatedFinding & { readonly persona?: string }>;
  /** Flaky findings (seen in fewer than k runs) — reported, not counted. */
  readonly flaky: Array<AggregatedFinding & { readonly persona?: string }>;
  /** One cell per persona (a single, persona-less cell without personas). */
  readonly cells: CellResult[];
  /** The persona matrix's diff (present only with personas). */
  readonly diff?: PersonaDiff;
  /** The aggregate result file (`multi-run.result.json` in the multi-run directory). */
  readonly resultPath: string;
  /** False while runs are still pending (the file is rewritten after every run). */
  readonly complete: boolean;
}

export interface RunMultiRunOptions {
  readonly plan: MultiRunPlan;
  readonly strategy: string;
  /** The multi-run directory: `<persona>/run-<i>/` per run plus `multi-run.result.json`. */
  readonly outDir: string;
  readonly runOnce: RunOnce;
}

function readTranscript(data: Record<string, unknown>): unknown {
  if (Array.isArray(data.transcript)) return data.transcript;
  if (typeof data.transcriptPath !== "string") return [];
  try {
    return JSON.parse(readFileSync(data.transcriptPath, "utf8"));
  } catch {
    return [];
  }
}

/** Summarizes one run's envelope (the only IO: its transcript file when the result omits it). */
export function summarizeRun(strategy: string, index: number, envelope: RunEnvelope, envelopePath?: string): RunSummary {
  const base = { index, ...(envelopePath === undefined ? {} : { envelopePath }) };
  if (!envelope.ok) {
    return { ...base, ok: false, outcome: "crashed", exitCode: MISSION_EXIT_CODES.crashed, findings: [], requests: {}, controls: [], error: envelope.error };
  }
  const data = isRecord(envelope.data) ? envelope.data : {};
  const resultPath = typeof data.resultPath === "string" ? data.resultPath : typeof data.reportPath === "string" ? data.reportPath : undefined;
  return {
    ...base,
    ok: true,
    outcome: runOutcomeOf(strategy, data),
    exitCode: typeof data.exitCode === "number" ? data.exitCode : MISSION_EXIT_CODES.inconclusive,
    findings: extractRunFindings(data),
    requests: extractRequests(data),
    controls: extractControls(readTranscript(data)),
    ...(resultPath === undefined ? {} : { resultPath }),
  };
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

/** Folds the voted cells into the aggregate (pure). */
export function aggregateCells(
  strategy: string,
  plan: MultiRunPlan,
  cells: CellResult[],
  resultPath: string,
  complete: boolean,
): MultiRunResult {
  const withPersona = <T extends AggregatedFinding>(c: CellResult, fs: T[]): Array<T & { persona?: string }> =>
    fs.map((f) => (c.persona === null ? f : { ...f, persona: c.persona }));
  const personas = plan.personas !== null;
  const outcomes = new Set(cells.map((c) => c.outcome));
  const outcome = !personas ? (cells[0]?.outcome ?? "intermittent") : outcomes.size === 1 ? [...outcomes][0]! : "mixed";
  return {
    kind: "multi-run",
    strategy,
    repeat: plan.repeat,
    minAgreement: plan.minAgreement,
    outcome,
    exitCode: cells.reduce((m, c) => Math.max(m, c.exitCode), 0),
    findings: cells.flatMap((c) => withPersona(c, c.findings)),
    flaky: cells.flatMap((c) => withPersona(c, c.flaky)),
    cells,
    ...(personas ? { diff: diffPersonas(cells) } : {}),
    resultPath,
    complete,
  };
}

/**
 * Runs the plan SEQUENTIALLY — persona by persona, `repeat` runs each, one at a time (never
 * concurrently) — writing each run's envelope next to its artifacts and rewriting the aggregate
 * after every run (so a killed multi-run still leaves the runs it finished, marked incomplete).
 */
export async function runMultiRun(opts: RunMultiRunOptions): Promise<MultiRunResult> {
  const { plan, strategy, outDir } = opts;
  const resultPath = join(outDir, "multi-run.result.json");
  const groups: ReadonlyArray<Persona | null> = plan.personas ?? [null];
  const cells: CellResult[] = [];
  for (const p of groups) {
    const runs: RunSummary[] = [];
    for (let i = 1; i <= plan.repeat; i++) {
      const runDir = join(outDir, p === null ? "" : p.name, `run-${i}`);
      mkdirSync(runDir, { recursive: true });
      // Strictly one at a time: the next run starts only after this one fully ended.
      const envelope = await opts.runOnce({ ...(p === null ? {} : { storageState: p.storageState }), outDir: runDir });
      const envelopePath = join(runDir, "run.envelope.json");
      writeJson(envelopePath, envelope);
      runs.push(summarizeRun(strategy, i, envelope, envelopePath));
      const partial = [...cells, voteRuns(runs, plan.minAgreement, p)];
      writeJson(resultPath, aggregateCells(strategy, plan, partial, resultPath, false));
    }
    cells.push(voteRuns(runs, plan.minAgreement, p));
  }
  const result = aggregateCells(strategy, plan, cells, resultPath, true);
  writeJson(resultPath, result);
  return result;
}
