import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import {
  MISSION_EXIT_CODES,
  RunTagError,
  clock,
  combineOutcomes,
  validateRunTags,
  type MissionOutcome,
} from "@jevitate/domain";
import { currentEngineInfo, type EngineInfo } from "./engine.js";
import { artifactStamp } from "./mission-journal.js";
import { logsDirFor } from "./project-dir.js";
import { summarizeRun, type RunEnvelope, type RunSummary } from "./multi-run.js";
import { CLI_TOOL_SPECS, buildCliArgv, type CliParam, type CliToolSpec } from "./mcp-cli-tools.js";
import { confineMcpPath, defaultMcpPathRoots } from "./mcp-paths.js";
import { EXPLORE_STRATEGIES } from "./cli-shared.js";
import { validateAllowControlPatterns, validateDenyPatterns } from "@jevitate/explore";
import { parseAuthCheck } from "./persona-login.js";

/**
 * `jevitate sweep` (#425): one release check over many targets (features/routes) × personas, run
 * with bounded concurrency, resumable, with ONE aggregated `sweep.result.json`.
 *
 * Every target is the SAME `explore` command a person would type (the multi-run/campaign pattern:
 * re-parsed in a fresh program, so every run goes through exactly the validation, gateways,
 * invariants and checks a single run does, and through the shared browser pool and the machine-wide
 * admission of resource governance). The sweep only adds:
 *
 *  - a targets file (`.tsv` or `.json`) validated up front — every problem listed, nothing run;
 *  - a worker pool of `--concurrency` runs;
 *  - `--resume`: a target whose `<out>/<id>/run.envelope.json` holds a finished run is not re-run;
 *  - `--stop-on-env-failure K`: when the first K runs of this invocation ALL failed for an
 *    environment/setup reason (auth expired, target unreachable, a crash, a command-level error),
 *    nothing else starts — the environment is broken, not the app;
 *  - the aggregate: per-target outcome, depth, tags; defects deduped by fingerprint ACROSS targets
 *    (one finding, N sightings); environment causes grouped.
 *
 * Every run is tagged `target=<id>` plus the sweep's and the target's own tags (#426).
 * Storage-state CONTENTS are never read here — only their (confined) paths travel.
 */

export class SweepSpecError extends Error {
  readonly code = "E_SWEEP_SPEC" as const;
  constructor(message: string) {
    super(message);
    this.name = "SweepSpecError";
  }
}

export class SweepArgsError extends Error {
  readonly code = "E_SWEEP_ARGS" as const;
  constructor(message: string) {
    super(message);
    this.name = "SweepArgsError";
  }
}

/** Upper bound on `--concurrency`: each run is a whole browser mission. */
export const MAX_SWEEP_CONCURRENCY = 16;
/** Upper bound on targets in one file. */
export const MAX_SWEEP_TARGETS = 1000;
const TARGET_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

/**
 * The `explore` options a target may set (`options` in JSON, extra columns in TSV): exactly the
 * value-typed arguments MCP `run_exploration` takes — so a targets file never grants a run more than
 * an MCP call could (no paths, no log commands, no secrets, no hooks) — minus the ones the sweep
 * owns per target (url, strategy, goal, persona/session, tags, out, AI mode, multi-run, journey anchor).
 */
const SWEEP_OWNED: ReadonlySet<string> = new Set([
  "url",
  "fromJourney",
  "atStep",
  "params",
  "env",
  "baseUrl",
  "strategy",
  "goal",
  "storageState",
  "saveStorageState",
  "persona",
  "personas",
  "actor",
  "repeat",
  "minAgreement",
  "out",
  "real",
  "fakeAi",
  "tags",
  "headed",
  "slowMo",
  // One Jev provider per sweep (`sweep --jev-provider`), like the AI mode.
  "jevProvider",
]);
const VALUE_KINDS: ReadonlySet<CliParam["kind"]> = new Set(["string", "integer", "number", "boolean", "string[]", "viewport"]);

function exploreParams(): Readonly<Record<string, CliParam>> {
  const spec = CLI_TOOL_SPECS.find((t) => t.name === "run_exploration");
  if (spec?.command === undefined) throw new Error("run_exploration spec missing");
  return spec.command.params;
}

/** The target option name → its typed explore argument (the allowed set). */
export function sweepTargetOptions(): Readonly<Record<string, CliParam>> {
  const out: Record<string, CliParam> = {};
  for (const [name, p] of Object.entries(exploreParams())) {
    if (SWEEP_OWNED.has(name) || p.positional === true || !VALUE_KINDS.has(p.kind)) continue;
    out[name] = p;
  }
  return out;
}

export interface SweepPersona {
  readonly name: string;
  /** Absolute, confined path of the persona's storage state (its contents are never read). */
  readonly storageState: string;
}

export interface SweepTarget {
  readonly id: string;
  /** The absolute start URL (`url`, or `route` resolved against the base URL). */
  readonly url: string;
  readonly route?: string;
  readonly persona?: SweepPersona;
  /** `--strategy`, when given (absent: explore's own default — goal, or a `feature` run). */
  readonly strategy?: string;
  readonly goal?: string;
  /** The target's own tags (the sweep's and `target=<id>` are added at run time). */
  readonly tags: Readonly<Record<string, string>>;
  /** The validated pass-through explore options, as given. */
  readonly options: Readonly<Record<string, unknown>>;
  /** Those options as explore flags (`--flag=value`, built by code — no value can become a flag). */
  readonly optionArgv: readonly string[];
}

export interface LoadSweepTargetsOptions {
  /** `--base-url` (or `--env`'s base URL): resolves a target's `route`; wins over the file's `baseUrl`. */
  readonly baseUrl?: string;
  /** Extra roots a persona storage state may live in (default: the project and `~/.jevitate`). */
  readonly roots?: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

interface RawTarget {
  readonly where: string;
  readonly fields: Record<string, unknown>;
  /** TSV: option values are strings, typed here by their parameter kind. */
  readonly fromTsv: boolean;
}

/** `a=1;b=2` (a TSV `tags` cell) → `{a: "1", b: "2"}`. */
function tsvTags(cell: string, where: string, problems: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of cell.split(";").map((p) => p.trim()).filter((p) => p !== "")) {
    const eq = part.indexOf("=");
    if (eq <= 0) {
      problems.push(`${where}: tags entry ${JSON.stringify(part)} must be key=value (entries separated by ';')`);
      continue;
    }
    out[part.slice(0, eq)] = part.slice(eq + 1);
  }
  return out;
}

/** A TSV option cell typed by its parameter's kind. */
function tsvOption(p: CliParam, cell: string, key: string, where: string, problems: string[]): unknown {
  switch (p.kind) {
    case "integer":
    case "number": {
      const n = Number(cell);
      if (cell.trim() === "" || !Number.isFinite(n)) problems.push(`${where}: ${key} must be a number, got ${JSON.stringify(cell)}`);
      return n;
    }
    case "boolean":
      if (cell !== "true" && cell !== "false") problems.push(`${where}: ${key} must be true or false, got ${JSON.stringify(cell)}`);
      return cell === "true";
    case "string[]":
      if (cell.trim().startsWith("[")) {
        try {
          return JSON.parse(cell) as unknown;
        } catch {
          problems.push(`${where}: ${key} must be a JSON array of strings or a single value`);
          return [];
        }
      }
      return [cell];
    case "viewport": {
      const m = /^(\d+)x(\d+)$/.exec(cell.trim());
      if (m === null) problems.push(`${where}: ${key} must be <width>x<height>, got ${JSON.stringify(cell)}`);
      return m === null ? undefined : { width: Number(m[1]), height: Number(m[2]) };
    }
    default:
      return cell;
  }
}

const TSV_FIELDS = new Set(["id", "url", "route", "persona", "strategy", "goal", "tags"]);

interface ParsedTargets {
  readonly baseUrl?: string;
  readonly defaults?: Record<string, unknown>;
  readonly rows: RawTarget[];
  readonly problems: string[];
}

function parseTsv(text: string, path: string): ParsedTargets {
  const problems: string[] = [];
  const lines = text.split(/\r?\n/).map((l, i) => ({ l, n: i + 1 })).filter(({ l }) => l.trim() !== "" && !l.trimStart().startsWith("#"));
  if (lines.length === 0) return { rows: [], problems: [`${path}: no header row (id, url|route, persona, strategy, goal, tags, <explore options>…)`] };
  const header = lines[0]!.l.split("\t").map((h) => h.trim());
  const seen = new Set<string>();
  for (const h of header) {
    if (h === "") problems.push(`${path}: the header has an empty column name`);
    if (seen.has(h)) problems.push(`${path}: the header names column ${JSON.stringify(h)} twice`);
    seen.add(h);
  }
  if (!seen.has("id")) problems.push(`${path}: the header has no 'id' column`);
  const options = sweepTargetOptions();
  const rows: RawTarget[] = [];
  for (const { l, n } of lines.slice(1)) {
    const where = `${path}:${n}`;
    const cells = l.split("\t");
    if (cells.length > header.length) problems.push(`${where}: ${cells.length} cells but the header has ${header.length} columns`);
    const fields: Record<string, unknown> = {};
    const opts: Record<string, unknown> = {};
    header.forEach((h, i) => {
      const cell = (cells[i] ?? "").trim();
      if (cell === "") return;
      if (h === "tags") fields.tags = tsvTags(cell, where, problems);
      else if (TSV_FIELDS.has(h)) fields[h] = cell;
      else if (options[h] !== undefined) opts[h] = tsvOption(options[h], cell, h, where, problems);
      else opts[h] = cell; // refused (unknown option) with the allowed list, below
    });
    if (Object.keys(opts).length > 0) fields.options = opts;
    rows.push({ where, fields, fromTsv: true });
  }
  return { rows, problems };
}

function parseJson(text: string, path: string): ParsedTargets {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return { rows: [], problems: [`${path} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`] };
  }
  const problems: string[] = [];
  const list = Array.isArray(raw) ? raw : isRecord(raw) && Array.isArray(raw.targets) ? raw.targets : null;
  if (list === null) return { rows: [], problems: [`${path} must be an array of targets or {"targets": [...]}`] };
  let baseUrl: string | undefined;
  let defaults: Record<string, unknown> | undefined;
  if (isRecord(raw)) {
    for (const k of Object.keys(raw)) if (!["targets", "baseUrl", "defaults", "name"].includes(k)) problems.push(`${path}: unknown key ${JSON.stringify(k)} (allowed: targets, baseUrl, defaults, name)`);
    if (raw.baseUrl !== undefined) {
      if (typeof raw.baseUrl === "string") baseUrl = raw.baseUrl;
      else problems.push(`${path}: baseUrl must be a string`);
    }
    if (raw.defaults !== undefined) {
      if (isRecord(raw.defaults)) defaults = raw.defaults;
      else problems.push(`${path}: defaults must be an object`);
    }
  }
  const rows = list.map((t, i): RawTarget => {
    const where = `${path}: targets[${i}]${isRecord(t) && typeof t.id === "string" ? ` (${t.id})` : ""}`;
    if (!isRecord(t)) {
      problems.push(`${where} must be an object`);
      return { where, fields: {}, fromTsv: false };
    }
    return { where, fields: t, fromTsv: false };
  });
  return { ...(baseUrl === undefined ? {} : { baseUrl }), ...(defaults === undefined ? {} : { defaults }), rows, problems };
}

const TARGET_KEYS = new Set(["id", "url", "route", "persona", "strategy", "goal", "tags", "options"]);
const DEFAULT_KEYS = new Set(["persona", "strategy", "goal", "tags", "options"]);

function httpUrl(v: string): URL | undefined {
  try {
    const u = new URL(v);
    return u.protocol === "http:" || u.protocol === "https:" ? u : undefined;
  } catch {
    return undefined;
  }
}

function personaOf(value: unknown, base: string, roots: readonly string[], where: string, problems: string[]): SweepPersona | undefined {
  let name: string | undefined;
  let file: string | undefined;
  if (typeof value === "string") {
    const eq = value.indexOf("=");
    // `name=path`, or a bare path (the persona is named after the file).
    if (eq > 0 && !value.slice(0, eq).includes("/")) {
      name = value.slice(0, eq);
      file = value.slice(eq + 1);
    } else file = value;
  } else if (isRecord(value) && typeof value.storageState === "string") {
    file = value.storageState;
    if (value.name !== undefined) {
      if (typeof value.name === "string") name = value.name;
      else problems.push(`${where}: persona.name must be a string`);
    }
  } else {
    problems.push(`${where}: persona must be a storage-state path, "name=<path>" or {"name", "storageState"}`);
    return undefined;
  }
  if (file === undefined || file.trim() === "") {
    problems.push(`${where}: persona storage state path is empty`);
    return undefined;
  }
  const abs = resolve(base, file);
  const personaName = name ?? basename(abs, extname(abs));
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(personaName)) {
    problems.push(`${where}: persona name ${JSON.stringify(personaName)} must be 1-64 of [A-Za-z0-9_.-], starting alphanumeric`);
    return undefined;
  }
  try {
    // The same confinement as an MCP session argument (the targets file may come from an MCP call):
    // inside the targets file's directory, the project or ~/.jevitate — never a repo's .jevitate/.
    const confined = confineMcpPath(abs, `persona of ${where}`, roots, { session: true });
    if (!existsSync(confined)) {
      problems.push(`${where}: persona storage state not found: ${confined}`);
      return undefined;
    }
    return { name: personaName, storageState: confined };
  } catch (err) {
    problems.push(err instanceof Error ? err.message : String(err));
    return undefined;
  }
}

const OPTION_SPEC = (params: Readonly<Record<string, CliParam>>): CliToolSpec => ({
  name: "sweep-target",
  description: "",
  command: { path: "explore", params, omitted: {} },
});

/** A target's options as explore flags (typed and closed: an unknown option or a wrong type is a problem). */
function optionArgvOf(options: Record<string, unknown>, where: string, problems: string[]): string[] {
  const allowed = sweepTargetOptions();
  const unknown = Object.keys(options).filter((k) => allowed[k] === undefined);
  if (unknown.length > 0) {
    problems.push(
      `${where}: unknown or not-allowed explore option(s) ${unknown.join(", ")} (a target may set: ${Object.keys(allowed).sort().join(", ")}; ` +
        "url/route, persona, strategy, goal and tags are their own fields)",
    );
    return [];
  }
  try {
    const argv = buildCliArgv(OPTION_SPEC(allowed), options as Record<string, never>, []);
    // ["explore", …flags, "--"]: the flags only.
    return argv.slice(1, argv.lastIndexOf("--"));
  } catch (err) {
    problems.push(`${where}: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

const stringList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : typeof v === "string" ? [v] : []);

/**
 * The checks `explore` itself makes on these options before a browser opens — made here, for every
 * target, before ANY run: regexes (`deny`, `allowControl`) compile (and an allow-control pattern is
 * never a blanket waiver), `authCheck` is a known mode, and the minimum effort is a goal run's.
 */
function validateRunShaping(options: Record<string, unknown>, strategy: string, where: string, problems: string[]): void {
  for (const [key, flag, check] of [
    ["deny", "deny", validateDenyPatterns],
    ["allowControl", "allowControl", validateAllowControlPatterns],
  ] as const) {
    if (options[key] === undefined) continue;
    try {
      check(stringList(options[key]), flag);
    } catch (err) {
      problems.push(`${where}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (options.authCheck !== undefined) {
    try {
      parseAuthCheck(typeof options.authCheck === "string" ? options.authCheck : String(options.authCheck));
    } catch (err) {
      problems.push(`${where}: ${(err instanceof Error ? err.message : String(err)).replace("--auth-check", "authCheck")}`);
    }
  }
  for (const key of ["minActions", "minDistinctStates"] as const) {
    const v = options[key];
    if (v === undefined) continue;
    if (typeof v !== "number" || !Number.isInteger(v) || v < 1) problems.push(`${where}: ${key} must be a positive integer`);
    if (strategy !== "goal" || options.feature !== undefined) problems.push(`${where}: ${key} is supported only with strategy goal (a goal or find-out run), not ${options.feature !== undefined ? "a feature run" : strategy}`);
  }
}

/**
 * Loads and validates a targets file (`.tsv`: a header row then one target per line; `.json`: an
 * array or `{baseUrl?, defaults?, targets}`). EVERY problem is listed in one `SweepSpecError`
 * (exit 64) — nothing runs on a half-valid file.
 */
export function loadSweepTargets(path: string, opts: LoadSweepTargetsOptions = {}): SweepTarget[] {
  const abs = resolve(path);
  if (!existsSync(abs)) throw new SweepSpecError(`targets file not found: ${abs}`);
  const text = readFileSync(abs, "utf8");
  const isTsv = /\.(tsv|txt)$/i.test(abs);
  const parsed: ParsedTargets = isTsv ? parseTsv(text, path) : parseJson(text, path);
  const problems = [...parsed.problems];
  const defaults: Record<string, unknown> = parsed.defaults ?? {};
  for (const k of Object.keys(defaults)) if (!DEFAULT_KEYS.has(k)) problems.push(`${path}: defaults.${k} is not a default a target can inherit (allowed: ${[...DEFAULT_KEYS].join(", ")})`);
  const env = opts.env ?? process.env;
  const baseUrl = opts.baseUrl ?? parsed.baseUrl ?? env["JEVITATE_BASE_URL"];
  if (baseUrl !== undefined && httpUrl(baseUrl) === undefined) problems.push(`base URL ${JSON.stringify(baseUrl)} must be an absolute http(s) URL`);
  const base = dirname(abs);
  const roots = [base, ...(opts.roots ?? defaultMcpPathRoots())];
  if (parsed.rows.length === 0 && problems.length === 0) problems.push(`${path}: no targets`);
  if (parsed.rows.length > MAX_SWEEP_TARGETS) problems.push(`${path}: ${parsed.rows.length} targets; at most ${MAX_SWEEP_TARGETS} per sweep`);

  let defaultTags: Record<string, string> = {};
  if (defaults.tags !== undefined) {
    try {
      defaultTags = validateRunTags(defaults.tags, "defaults.tags");
    } catch (err) {
      problems.push(`${path}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (defaults.options !== undefined && !isRecord(defaults.options)) problems.push(`${path}: defaults.options must be an object`);

  const ids = new Set<string>();
  const targets: SweepTarget[] = [];
  for (const row of parsed.rows) {
    const { where } = row;
    const f = row.fields;
    if (!row.fromTsv) for (const k of Object.keys(f)) if (!TARGET_KEYS.has(k)) problems.push(`${where}: unknown key ${JSON.stringify(k)} (allowed: ${[...TARGET_KEYS].join(", ")})`);
    const id = f.id;
    if (typeof id !== "string" || !TARGET_ID.test(id)) {
      problems.push(`${where}: id must be 1-64 of [A-Za-z0-9_.-], starting alphanumeric (it names the target's directory and its target=<id> tag)`);
      continue;
    }
    if (ids.has(id)) problems.push(`${where}: id ${id} is used twice`);
    ids.add(id);

    // url | route
    let url: string | undefined;
    const route = typeof f.route === "string" ? f.route : undefined;
    if (f.url !== undefined && f.route !== undefined) problems.push(`${where}: give url or route, not both`);
    else if (typeof f.url === "string") {
      if (httpUrl(f.url) === undefined) problems.push(`${where}: url ${JSON.stringify(f.url)} must be an absolute http(s) URL`);
      else url = f.url;
    } else if (route !== undefined) {
      if (!route.startsWith("/")) problems.push(`${where}: route ${JSON.stringify(route)} must start with '/'`);
      else if (baseUrl === undefined) problems.push(`${where}: route ${route} needs a base URL (--base-url, --env, the file's baseUrl or JEVITATE_BASE_URL)`);
      else if (httpUrl(baseUrl) !== undefined) url = new URL(route, baseUrl).toString();
    } else problems.push(`${where}: needs url or route`);

    const pick = (k: string): unknown => (f[k] !== undefined ? f[k] : defaults[k]);
    const strategy = pick("strategy");
    if (strategy !== undefined && (typeof strategy !== "string" || !(EXPLORE_STRATEGIES as readonly string[]).includes(strategy))) {
      problems.push(`${where}: strategy ${JSON.stringify(strategy)} must be one of ${EXPLORE_STRATEGIES.join(", ")}`);
    }
    const goal = pick("goal");
    if (goal !== undefined && (typeof goal !== "string" || goal.trim() === "")) problems.push(`${where}: goal must be a non-empty string`);

    const options: Record<string, unknown> = { ...(isRecord(defaults.options) ? defaults.options : {}), ...(isRecord(f.options) ? f.options : {}) };
    if (f.options !== undefined && !isRecord(f.options)) problems.push(`${where}: options must be an object`);
    const effectiveStrategy = typeof strategy === "string" ? strategy : "goal";
    if ((effectiveStrategy === "goal" || effectiveStrategy === "usability") && typeof goal !== "string" && options.feature === undefined) {
      problems.push(`${where}: strategy ${effectiveStrategy} needs a goal${effectiveStrategy === "goal" ? " (or options.feature for a feature run)" : ""}`);
    }
    const optionArgv = optionArgvOf(options, where, problems);
    validateRunShaping(options, effectiveStrategy, where, problems);

    let tags: Record<string, string> = { ...defaultTags };
    if (f.tags !== undefined) {
      try {
        tags = { ...tags, ...validateRunTags(f.tags, "tags") };
      } catch (err) {
        if (!(err instanceof RunTagError)) throw err;
        problems.push(`${where}: ${err.message}`);
      }
    }
    if (tags.target !== undefined && tags.target !== id) problems.push(`${where}: tag 'target' is reserved (every run is tagged target=<id>)`);

    const personaRaw = pick("persona");
    const persona = personaRaw === undefined ? undefined : personaOf(personaRaw, base, roots, where, problems);

    if (url === undefined) continue;
    targets.push({
      id,
      url,
      ...(route === undefined ? {} : { route }),
      ...(persona === undefined ? {} : { persona }),
      ...(typeof strategy === "string" ? { strategy } : {}),
      ...(typeof goal === "string" ? { goal } : {}),
      tags,
      options,
      optionArgv,
    });
  }
  if (problems.length > 0) throw new SweepSpecError(`invalid targets file (${problems.length} problem(s)):\n- ${problems.join("\n- ")}`);
  return targets;
}

// ── Running ──────────────────────────────────────────────────────────────────────────────────

export interface SweepPlan {
  readonly targetsPath: string;
  readonly targets: readonly SweepTarget[];
  readonly concurrency: number;
  readonly resume: boolean;
  readonly outDir: string;
  /** `--stop-on-env-failure K`: abort when the first K runs all failed for environment/setup reasons. */
  readonly stopOnEnvFailure?: number;
  /** The sweep's own `--tag`s, added to every run (a target's own tag of the same key wins). */
  readonly tags: Readonly<Record<string, string>>;
  /** Flags every run is invoked with (the sweep's forwarded operator flags, the AI mode). */
  readonly runArgs: readonly string[];
}

export interface SweepRunArgs {
  readonly target: SweepTarget;
  /** The full `explore …` argv this target runs with. */
  readonly argv: readonly string[];
  readonly runDir: string;
}

/** Runs ONE target (the real one re-parses `explore` in process); returns its JSON envelope. */
export type SweepRunOnce = (args: SweepRunArgs) => Promise<RunEnvelope>;

export type SweepTargetStatus = "ran" | "resumed" | "error" | "skipped" | "pending";

export interface SweepTargetResult {
  readonly id: string;
  readonly url: string;
  readonly persona?: string;
  readonly strategy: string;
  readonly tags: Readonly<Record<string, string>>;
  /**
   * `ran` · `resumed` (a finished run from a previous invocation, not re-run) · `error` (the run could
   * not start) · `skipped` (the sweep stopped first) · `pending` (not finished yet: an in-progress file).
   */
  readonly status: SweepTargetStatus;
  readonly missionOutcome: MissionOutcome;
  readonly goalOutcome?: string;
  readonly exitCode: number;
  readonly defectOutcome?: unknown;
  /** The run's `depth` (distinct states, actions, forms submitted), when its result carries one. */
  readonly depth?: unknown;
  /** #428: every safety refusal an `allowControl` exemption waived in the run, as its result records them. */
  readonly safetyOverrides?: unknown;
  /** Why the run ended as it did (its failure, a stop reason). */
  readonly failure?: { readonly kind: string; readonly message: string };
  /** Set when the run failed for an environment/setup reason (counted by --stop-on-env-failure). */
  readonly environmentFailure?: { readonly kind: string; readonly message: string };
  /** How many defects (and hangs) the run reported. */
  readonly defects: number;
  readonly resultPath?: string;
  readonly envelopePath?: string;
}

export interface SweepSighting {
  readonly target: string;
  readonly route?: string;
  readonly url?: string;
  readonly count?: number;
  readonly resultPath?: string;
}

/** One defect, deduped by fingerprint across every target that saw it. */
export interface SweepDefect {
  readonly fingerprint: string;
  readonly kind: string;
  readonly title?: string;
  readonly advisory?: true;
  /** `server-log` defects: the log line's level, source and message. */
  readonly level?: string;
  readonly source?: string;
  readonly message?: string;
  /** How many targets saw it (`sightings.length`). */
  readonly sightingCount: number;
  readonly targets: readonly string[];
  readonly sightings: readonly SweepSighting[];
}

/** An environment cause (a run's `environmentFaults` cause or `environmentDegraded` finding, or a run's environment failure), grouped. */
export interface SweepEnvironmentCause {
  readonly ruleId?: string;
  readonly kind?: string;
  readonly source?: string;
  readonly message: string;
  readonly count: number;
  readonly targets: readonly string[];
}

export interface SweepResult {
  readonly kind: "sweep";
  readonly targetsPath: string;
  readonly outDir: string;
  readonly resultPath: string;
  readonly startedAt: string;
  readonly finishedAt?: string;
  /** False while targets are still pending (the file is rewritten after every run), or after a stop. */
  readonly complete: boolean;
  readonly concurrency: number;
  readonly tags: Readonly<Record<string, string>>;
  /** The worst target outcome (`combineOutcomes`); `inconclusive` while incomplete or after a stop. */
  readonly missionOutcome: MissionOutcome;
  readonly exitCode: number;
  readonly reason?: string;
  readonly aborted?: { readonly reason: string; readonly afterRuns: number };
  readonly interrupted?: { readonly signal: string };
  readonly engine: EngineInfo;
  readonly summary: {
    readonly targets: number;
    readonly ran: number;
    readonly resumed: number;
    readonly errors: number;
    readonly skipped: number;
    readonly pending: number;
    readonly byOutcome: Readonly<Record<string, number>>;
    readonly defects: number;
    readonly environmentFailures: number;
  };
  readonly targets: readonly SweepTargetResult[];
  readonly defects: readonly SweepDefect[];
  readonly environment: {
    /** Each run's `environmentFaults` causes (#422) and `environmentDegraded` findings (#203), grouped by rule/cause, source and message. */
    readonly causes: readonly SweepEnvironmentCause[];
    /** Runs that failed for an environment/setup reason, grouped by kind. */
    readonly failures: readonly SweepEnvironmentCause[];
  };
}

/** Failure kinds that mean the environment (or setup), not the app, ended the run. */
const ENVIRONMENT_FAILURE_KINDS: ReadonlySet<string> = new Set([
  "auth-expired",
  "target-unreachable",
  "target-unresponsive",
  "configuration",
  "degraded-environment",
  "resource-limit",
  "browser-disconnected",
]);

/** Why a run failed for an environment/setup reason, if it did. */
export function environmentFailureOf(s: RunSummary): { kind: string; message: string } | undefined {
  if (!s.ok) return { kind: "setup", message: s.reason ?? `${s.error?.code ?? "E_UNKNOWN"}: ${s.error?.message ?? ""}` };
  if (s.failureKind !== undefined && ENVIRONMENT_FAILURE_KINDS.has(s.failureKind)) return { kind: s.failureKind, message: s.reason ?? s.failureKind };
  if (s.sessionLost !== undefined) return { kind: "session-lost", message: s.sessionLost };
  if (s.missionOutcome === "crashed") return { kind: "crashed", message: s.reason ?? "the run crashed" };
  return undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

/** The finished target's row, from its envelope (pure, but for summarizeRun's transcript read). */
export function targetResultOf(target: SweepTarget, envelope: RunEnvelope, status: "ran" | "resumed", envelopePath: string, tags: Readonly<Record<string, string>>): SweepTargetResult {
  const strategy = target.strategy ?? (target.options.feature !== undefined ? "feature" : "goal");
  const s = summarizeRun(strategy, 1, envelope, envelopePath);
  const data = envelope.ok && isRecord(envelope.data) ? envelope.data : {};
  const failureRec = isRecord(data.failure) ? data.failure : isRecord(data.crash) && isRecord(data.crash.failure) ? data.crash.failure : undefined;
  const failure =
    failureRec !== undefined && typeof failureRec.kind === "string"
      ? { kind: failureRec.kind, message: str(failureRec.message) ?? "" }
      : !envelope.ok
        ? { kind: "setup", message: `${envelope.error.code}: ${envelope.error.message}` }
        : undefined;
  const env = environmentFailureOf(s);
  const defects = (Array.isArray(data.defects) ? data.defects.length : 0) + (Array.isArray(data.hangs) ? data.hangs.length : 0);
  return {
    id: target.id,
    url: target.url,
    ...(target.persona === undefined ? {} : { persona: target.persona.name }),
    strategy,
    tags,
    status: envelope.ok ? status : "error",
    missionOutcome: envelope.ok ? s.missionOutcome : "inconclusive",
    ...(s.goalOutcome === undefined ? {} : { goalOutcome: s.goalOutcome }),
    exitCode: envelope.ok ? s.exitCode : MISSION_EXIT_CODES.inconclusive,
    ...(data.defectOutcome === undefined ? {} : { defectOutcome: data.defectOutcome }),
    ...(data.depth === undefined ? {} : { depth: data.depth }),
    ...(Array.isArray(data.safetyOverrides) && data.safetyOverrides.length > 0 ? { safetyOverrides: data.safetyOverrides } : {}),
    ...(failure === undefined ? {} : { failure }),
    ...(env === undefined ? {} : { environmentFailure: env }),
    defects,
    ...(s.resultPath === undefined ? {} : { resultPath: s.resultPath }),
    envelopePath,
  };
}

/** Defects (and hangs) of every finished target, deduped by fingerprint across targets. */
export function dedupeSweepDefects(runs: ReadonlyArray<{ readonly target: string; readonly envelope: RunEnvelope; readonly resultPath?: string }>): SweepDefect[] {
  const byFp = new Map<string, { first: Record<string, unknown>; sightings: SweepSighting[]; advisory: boolean }>();
  for (const { target, envelope, resultPath } of runs) {
    if (!envelope.ok || !isRecord(envelope.data)) continue;
    const list = [...(Array.isArray(envelope.data.defects) ? envelope.data.defects : []), ...(Array.isArray(envelope.data.hangs) ? envelope.data.hangs : [])];
    const seenHere = new Set<string>();
    for (const d of list) {
      if (!isRecord(d) || typeof d.fingerprint !== "string" || seenHere.has(d.fingerprint)) continue;
      seenHere.add(d.fingerprint);
      const cur = byFp.get(d.fingerprint) ?? { first: d, sightings: [], advisory: true };
      const count = typeof d.count === "number" ? d.count : typeof d.occurrences === "number" ? d.occurrences : undefined;
      cur.sightings.push({
        target,
        ...(str(d.route) === undefined ? {} : { route: str(d.route)! }),
        ...(str(d.url) === undefined ? {} : { url: str(d.url)! }),
        ...(count === undefined ? {} : { count }),
        ...(resultPath === undefined ? {} : { resultPath }),
      });
      // Advisory only when EVERY sighting was advisory (a gating sighting anywhere makes it a defect).
      cur.advisory = cur.advisory && d.advisory === true;
      byFp.set(d.fingerprint, cur);
    }
  }
  const out: SweepDefect[] = [...byFp.entries()].map(([fingerprint, { first, sightings, advisory }]) => ({
    fingerprint,
    kind: str(first.kind) ?? "unknown",
    ...(str(first.title) === undefined ? {} : { title: str(first.title)! }),
    ...(advisory ? { advisory: true as const } : {}),
    ...(str(first.level) === undefined ? {} : { level: str(first.level)! }),
    ...(str(first.source) === undefined ? {} : { source: str(first.source)! }),
    ...(str(first.message) === undefined ? {} : { message: str(first.message)! }),
    sightingCount: sightings.length,
    targets: [...new Set(sightings.map((s) => s.target))],
    sightings,
  }));
  out.sort((a, b) => b.sightingCount - a.sightingCount || a.fingerprint.localeCompare(b.fingerprint));
  return out;
}

/**
 * Every run's environment causes grouped across targets: its classified backend-log faults
 * (`environmentFaults: {causes: [{ruleId, source, message, count}]}`, #422) and its starved-host
 * findings (`environmentDegraded: [{finding, cause, detail}]`, #203).
 */
export function groupEnvironmentCauses(runs: ReadonlyArray<{ readonly target: string; readonly envelope: RunEnvelope }>): SweepEnvironmentCause[] {
  const groups = new Map<string, { ruleId?: string; source?: string; message: string; count: number; targets: Set<string> }>();
  const add = (target: string, ruleId: string | undefined, source: string | undefined, message: string, count: number): void => {
    const key = `${ruleId ?? ""}\u0000${source ?? ""}\u0000${message}`;
    const g = groups.get(key) ?? { ...(ruleId === undefined ? {} : { ruleId }), ...(source === undefined ? {} : { source }), message, count: 0, targets: new Set<string>() };
    g.count += count;
    g.targets.add(target);
    groups.set(key, g);
  };
  for (const { target, envelope } of runs) {
    if (!envelope.ok || !isRecord(envelope.data)) continue;
    // #422: classified backend-log environment faults (`environmentFaults.causes`).
    const ef = envelope.data.environmentFaults;
    if (isRecord(ef) && Array.isArray(ef.causes)) {
      for (const c of ef.causes) {
        if (!isRecord(c)) continue;
        add(target, str(c.ruleId), str(c.source), str(c.message) ?? str(c.ruleId) ?? "environment fault", typeof c.count === "number" ? c.count : 1);
      }
    }
    // #203: findings met on a starved host (`environmentDegraded`, a per-finding array).
    const ed = envelope.data.environmentDegraded;
    if (Array.isArray(ed)) {
      for (const c of ed) {
        if (!isRecord(c)) continue;
        add(target, str(c.finding), undefined, str(c.cause) ?? str(c.detail) ?? "environment degraded", 1);
      }
    }
  }
  return [...groups.values()]
    .map((g) => ({ ...(g.ruleId === undefined ? {} : { ruleId: g.ruleId }), ...(g.source === undefined ? {} : { source: g.source }), message: g.message, count: g.count, targets: [...g.targets] }))
    .sort((a, b) => b.targets.length - a.targets.length || b.count - a.count || a.message.localeCompare(b.message));
}

function groupFailures(rows: readonly SweepTargetResult[]): SweepEnvironmentCause[] {
  const groups = new Map<string, { message: string; count: number; targets: string[] }>();
  for (const r of rows) {
    if (r.environmentFailure === undefined) continue;
    const g = groups.get(r.environmentFailure.kind) ?? { message: r.environmentFailure.message, count: 0, targets: [] };
    g.count += 1;
    g.targets.push(r.id);
    groups.set(r.environmentFailure.kind, g);
  }
  return [...groups.entries()].map(([kind, g]) => ({ kind, message: g.message, count: g.count, targets: g.targets })).sort((a, b) => b.count - a.count);
}

/** The run's tags: the sweep's, then the target's own (which win), then `target=<id>`. */
export function runTagsFor(plan: Pick<SweepPlan, "tags">, target: SweepTarget): Record<string, string> {
  return { ...plan.tags, ...target.tags, target: target.id };
}

/** The `explore` argv one target runs with. */
export function targetArgv(plan: Pick<SweepPlan, "tags" | "runArgs">, target: SweepTarget, runDir: string): string[] {
  return [
    "explore",
    "--url",
    target.url,
    "--target",
    target.id,
    ...(target.strategy === undefined ? [] : ["--strategy", target.strategy]),
    ...(target.goal === undefined ? [] : ["--goal", target.goal]),
    ...(target.persona === undefined ? [] : ["--storage-state", target.persona.storageState]),
    ...Object.entries(runTagsFor(plan, target)).flatMap(([k, v]) => ["--tag", `${k}=${v}`]),
    ...plan.runArgs,
    ...target.optionArgv,
    "--out",
    runDir,
    "--json",
  ];
}

/** A previous invocation's finished run for this target (`--resume`), else undefined. */
export function finishedEnvelope(envelopePath: string): RunEnvelope | undefined {
  if (!existsSync(envelopePath)) return undefined;
  try {
    const env = JSON.parse(readFileSync(envelopePath, "utf8")) as unknown;
    if (!isRecord(env) || env.ok !== true || !isRecord(env.data)) return undefined; // an error is retried
    if (env.data.interrupted !== undefined) return undefined;
    return env as RunEnvelope;
  } catch {
    return undefined; // a torn file is not a finished run
  }
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

/** Folds the target rows into the aggregate (pure). */
export function aggregateSweep(args: {
  readonly plan: SweepPlan;
  readonly rows: ReadonlyArray<SweepTargetResult | undefined>;
  readonly finished: ReadonlyArray<{ readonly target: string; readonly envelope: RunEnvelope; readonly resultPath?: string }>;
  readonly startedAt: string;
  readonly finishedAt?: string;
  readonly complete: boolean;
  readonly aborted?: { readonly reason: string; readonly afterRuns: number };
  readonly engine?: EngineInfo;
}): SweepResult {
  const { plan } = args;
  const rows: SweepTargetResult[] = plan.targets.map(
    (t, i) =>
      args.rows[i] ??
      ({
        id: t.id,
        url: t.url,
        ...(t.persona === undefined ? {} : { persona: t.persona.name }),
        strategy: t.strategy ?? (t.options.feature !== undefined ? "feature" : "goal"),
        tags: runTagsFor(plan, t),
        status: args.complete || args.aborted !== undefined ? "skipped" : "pending",
        missionOutcome: "inconclusive",
        exitCode: MISSION_EXIT_CODES.inconclusive,
        defects: 0,
        ...(args.aborted === undefined ? {} : { failure: { kind: "sweep-stopped", message: args.aborted.reason } }),
      } satisfies SweepTargetResult),
  );
  const done = rows.filter((r, i) => args.rows[i] !== undefined);
  const byOutcome: Record<string, number> = {};
  for (const r of done) byOutcome[r.missionOutcome] = (byOutcome[r.missionOutcome] ?? 0) + 1;
  // Deterministic whatever order runs finished in: sightings and causes follow the targets file.
  const order = new Map(plan.targets.map((t, i) => [t.id, i] as const));
  const finished = [...args.finished].sort((a, b) => (order.get(a.target) ?? 0) - (order.get(b.target) ?? 0));
  const defects = dedupeSweepDefects(finished);
  const failures = groupFailures(done);
  const pending = plan.targets.length - done.length;
  const finalOutcome = combineOutcomes(rows.map((r) => r.missionOutcome));
  const missionOutcome: MissionOutcome = args.complete ? finalOutcome : "inconclusive";
  const reason =
    args.aborted !== undefined
      ? args.aborted.reason
      : !args.complete
        ? `incomplete: ${done.length} of ${plan.targets.length} target(s) finished`
        : undefined;
  return {
    kind: "sweep",
    targetsPath: plan.targetsPath,
    outDir: plan.outDir,
    resultPath: join(plan.outDir, "sweep.result.json"),
    startedAt: args.startedAt,
    ...(args.finishedAt === undefined ? {} : { finishedAt: args.finishedAt }),
    complete: args.complete && args.aborted === undefined,
    concurrency: plan.concurrency,
    tags: plan.tags,
    missionOutcome: args.aborted === undefined ? missionOutcome : "inconclusive",
    exitCode: MISSION_EXIT_CODES[args.aborted === undefined ? missionOutcome : "inconclusive"],
    ...(reason === undefined ? {} : { reason }),
    ...(args.aborted === undefined ? {} : { aborted: args.aborted }),
    engine: args.engine ?? currentEngineInfo(),
    summary: {
      targets: plan.targets.length,
      ran: done.filter((r) => r.status === "ran").length,
      resumed: done.filter((r) => r.status === "resumed").length,
      errors: done.filter((r) => r.status === "error").length,
      skipped: args.complete || args.aborted !== undefined ? pending : 0,
      pending: args.complete || args.aborted !== undefined ? 0 : pending,
      byOutcome,
      defects: defects.filter((d) => d.advisory !== true).length,
      environmentFailures: done.filter((r) => r.environmentFailure !== undefined).length,
    },
    targets: rows,
    defects,
    environment: { causes: groupEnvironmentCauses(finished), failures },
  };
}

export interface RunSweepOptions {
  readonly plan: SweepPlan;
  readonly runOnce: SweepRunOnce;
  readonly nowIso?: () => string;
  /**
   * Armed for the whole sweep: `onKill` must be called SYNCHRONOUSLY on a kill signal; it rewrites
   * `sweep.result.json` (incomplete, `inconclusive`, the interrupting signal) and returns it.
   */
  readonly armKill?: (onKill: (signal: string, exitCode: number) => SweepResult) => () => void;
}

/** The default sweep directory: `.jevitate/logs/<date>/sweep-<stamp>`. */
export function defaultSweepOutDir(iso: string = clock.nowIso()): string {
  return join(logsDirFor(iso), `sweep-${artifactStamp(iso)}`);
}

/**
 * Runs the plan: resumed targets first (read back, never re-run), then a pool of `concurrency`
 * workers over the rest in file order. `sweep.result.json` is rewritten after every finished run.
 */
export async function runSweep(opts: RunSweepOptions): Promise<SweepResult> {
  const { plan } = opts;
  const now = opts.nowIso ?? (() => clock.nowIso());
  const startedAt = now();
  mkdirSync(plan.outDir, { recursive: true });
  const resultPath = join(plan.outDir, "sweep.result.json");
  const rows: Array<SweepTargetResult | undefined> = plan.targets.map(() => undefined);
  const finished: Array<{ target: string; envelope: RunEnvelope; resultPath?: string }> = [];
  const queue: number[] = [];
  plan.targets.forEach((t, i) => {
    const envelopePath = join(plan.outDir, t.id, "run.envelope.json");
    const prior = plan.resume ? finishedEnvelope(envelopePath) : undefined;
    if (prior === undefined) {
      queue.push(i);
      return;
    }
    const row = targetResultOf(t, prior, "resumed", envelopePath, runTagsFor(plan, t));
    rows[i] = row;
    finished.push({ target: t.id, envelope: prior, ...(row.resultPath === undefined ? {} : { resultPath: row.resultPath }) });
  });

  let aborted: { reason: string; afterRuns: number } | undefined;
  const thisRun: SweepTargetResult[] = [];
  const snapshot = (complete: boolean, finishedAt?: string): SweepResult =>
    aggregateSweep({ plan, rows, finished, startedAt, complete, ...(finishedAt === undefined ? {} : { finishedAt }), ...(aborted === undefined ? {} : { aborted }) });
  writeJson(resultPath, snapshot(queue.length === 0));

  const disarm = opts.armKill?.((signal, exitCode) => {
    const partial = snapshot(false);
    const result: SweepResult = { ...partial, reason: `interrupted by ${signal}; ${partial.targets.length - partial.summary.pending} of ${partial.summary.targets} target(s) finished`, interrupted: { signal }, exitCode };
    writeJson(resultPath, result);
    return result;
  });

  const runOne = async (i: number): Promise<void> => {
    const target = plan.targets[i]!;
    const runDir = join(plan.outDir, target.id);
    mkdirSync(runDir, { recursive: true });
    const envelopePath = join(runDir, "run.envelope.json");
    let envelope: RunEnvelope;
    try {
      envelope = await opts.runOnce({ target, argv: targetArgv(plan, target, runDir), runDir });
    } catch (err) {
      envelope = { ok: false, error: { code: "E_SWEEP_RUN", message: err instanceof Error ? err.message : String(err) } };
    }
    writeJson(envelopePath, envelope);
    const row = targetResultOf(target, envelope, "ran", envelopePath, runTagsFor(plan, target));
    rows[i] = row;
    if (envelope.ok) finished.push({ target: target.id, envelope, ...(row.resultPath === undefined ? {} : { resultPath: row.resultPath }) });
    thisRun.push(row);
    // --stop-on-env-failure K: judged once, on the K-th run of this invocation.
    const k = plan.stopOnEnvFailure;
    if (k !== undefined && aborted === undefined && thisRun.length === k && thisRun.every((r) => r.environmentFailure !== undefined)) {
      const kinds = [...new Set(thisRun.map((r) => r.environmentFailure!.kind))].join(", ");
      aborted = {
        reason: `stopped: the first ${k} run(s) all failed for environment/setup reasons (${kinds}) — fix the environment, then re-run with --resume`,
        afterRuns: k,
      };
    }
    writeJson(resultPath, snapshot(false));
  };

  try {
    let next = 0;
    const worker = async (): Promise<void> => {
      while (aborted === undefined && next < queue.length) {
        const i = queue[next++]!;
        await runOne(i);
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(plan.concurrency, queue.length)) }, () => worker()));
  } finally {
    disarm?.();
  }
  const result = snapshot(aborted === undefined, now());
  writeJson(resultPath, result);
  return result;
}
