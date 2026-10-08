import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { LogLevel, LogLine } from "./log-lines.js";
import { findProjectDir, type LayoutDeps } from "./project-dir.js";

/**
 * #422 — what a backend log line that matched `--log-defect` MEANS for this project: a product
 * `defect`, an `environment` fault (a placeholder API key, an unconfigured provider, a degraded
 * health check — fix it in setup, not in the product), or an `expected-validation` fault (a 4xx
 * validation error the mission's own input caused). Only `defect` lines become `server-log` defects
 * and gate the run; `environment` ones go to the result's `environmentFaults`, `expected-validation`
 * ones to `expectedValidation` — recorded, never failing the run.
 *
 * Rules come from the project's committed `.jevitate/log-classes.json` FIRST, then the built-in
 * defaults below (a project rule with a default's `id` replaces it). The first rule that matches a
 * line wins; a line no rule matches stays a defect (the `--log-defect` oracle's own verdict). The
 * file is validated strictly — an unknown key, class or level, a bad regex, a duplicate id or a rule
 * that matches nothing in particular is refused (fail closed) before any browser opens.
 *
 *     { "version": 1, "rules": [
 *         { "id": "stripe-test-mode", "class": "environment", "message": "/No such customer.*test mode/i" },
 *         { "id": "signup-422", "class": "expected-validation", "source": "docker:api", "level": "warn",
 *           "message": "validation failed" } ] }
 *
 * `message` is matched against the line's parsed message, `source` against its `--log-source` spec;
 * each is a `/pattern/flags` regex or a bare pattern (compiled as-is, case-sensitive). `level` is
 * one level name (`error`, `warn`, `info`, `debug`, `unknown`), matched exactly.
 */

export const LOG_CLASSES_FILE = "log-classes.json";
export const LOG_CLASSES = ["environment", "expected-validation", "defect"] as const;
export type LogClass = (typeof LOG_CLASSES)[number];

const LEVELS: readonly LogLevel[] = ["error", "warn", "info", "debug", "unknown"];
const RULE_KEYS = new Set(["id", "class", "message", "source", "level"]);
const MAX_PATTERN_LENGTH = 500;
const REGEX_SPEC = /^\/(.*)\/([a-z]*)$/s;

export interface LogClassRule {
  readonly id: string;
  readonly class: LogClass;
  readonly message?: RegExp;
  readonly source?: RegExp;
  readonly level?: LogLevel;
}

/** One classified cause on a result (`environmentFaults.causes[]`, `expectedValidation[]`). */
export interface LogClassCause {
  readonly ruleId: string;
  /** The `--log-source` spec the first matching line came from. */
  readonly source: string;
  /** The first matching line's message, redacted with the run's secrets. */
  readonly message: string;
  readonly count: number;
}

/**
 * The built-in rules (#422): a missing or invalid credential and a degraded health check are the
 * environment's fault unless the project's file says otherwise (same `id` replaces one; a project
 * rule matching the same line first wins anyway).
 */
export const DEFAULT_LOG_CLASS_RULES: readonly LogClassRule[] = [
  {
    id: "default:credential",
    class: "environment",
    message: /incorrect api key|invalid api key|unauthorized.*(api|key)|missing (api )?key|not configured/i,
  },
  { id: "default:health-check-degraded", class: "environment", message: /health.?check.*(degraded|unhealthy)/i },
];

/** `.jevitate/log-classes.json` is not what it must be — refused before any browser opens. */
export class LogClassesError extends Error {
  readonly code = "E_LOG_CLASSES" as const;
  constructor(message: string) {
    super(message);
    this.name = "LogClassesError";
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function compile(value: unknown, where: string): RegExp {
  if (typeof value !== "string" || value === "") throw new LogClassesError(`${where} must be a non-empty regex string`);
  const m = REGEX_SPEC.exec(value);
  const pattern = m === null ? value : (m[1] ?? "");
  const flags = m === null ? "" : (m[2] ?? "");
  if (/[gy]/.test(flags)) throw new LogClassesError(`${where}: the g and y flags are not allowed (a rule is tested line by line)`);
  if (pattern.length > MAX_PATTERN_LENGTH) throw new LogClassesError(`${where} is too long (max ${MAX_PATTERN_LENGTH} chars)`);
  try {
    return new RegExp(pattern, flags);
  } catch (e) {
    throw new LogClassesError(`${where} is not a valid regex ${JSON.stringify(value)}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * Validates a parsed `log-classes.json` (strict: fail closed on anything unexpected) and returns
 * its rules, in file order. `file` names the file in every error.
 */
export function parseLogClasses(raw: unknown, file: string): LogClassRule[] {
  if (!isRecord(raw)) throw new LogClassesError(`${file}: must be a JSON object { "version": 1, "rules": [...] }`);
  for (const k of Object.keys(raw)) {
    if (k !== "version" && k !== "rules") throw new LogClassesError(`${file}: unknown key "${k}" (allowed: version, rules)`);
  }
  if (raw.version !== 1) throw new LogClassesError(`${file}: "version" must be 1`);
  if (!Array.isArray(raw.rules)) throw new LogClassesError(`${file}: "rules" must be an array`);
  const seen = new Set<string>();
  return raw.rules.map((r, i): LogClassRule => {
    const at = `${file}: rules[${i}]`;
    if (!isRecord(r)) throw new LogClassesError(`${at} must be an object`);
    const id = r.id;
    if (typeof id !== "string" || id.trim() === "") throw new LogClassesError(`${at}: "id" must be a non-empty string`);
    const where = `${file}: rule "${id}"`;
    if (seen.has(id)) throw new LogClassesError(`${where}: duplicate id`);
    seen.add(id);
    for (const k of Object.keys(r)) {
      if (!RULE_KEYS.has(k)) throw new LogClassesError(`${where}: unknown key "${k}" (allowed: ${[...RULE_KEYS].join(", ")})`);
    }
    if (typeof r.class !== "string" || !(LOG_CLASSES as readonly string[]).includes(r.class)) {
      throw new LogClassesError(`${where}: unknown class ${JSON.stringify(r.class)} (allowed: ${LOG_CLASSES.join(", ")})`);
    }
    if (r.message === undefined && r.source === undefined && r.level === undefined) {
      throw new LogClassesError(`${where}: needs at least one of "message", "source", "level" — a rule without one would classify every line`);
    }
    if (r.level !== undefined && (typeof r.level !== "string" || !(LEVELS as readonly string[]).includes(r.level))) {
      throw new LogClassesError(`${where}: unknown level ${JSON.stringify(r.level)} (allowed: ${LEVELS.join(", ")})`);
    }
    return {
      id,
      class: r.class as LogClass,
      ...(r.message === undefined ? {} : { message: compile(r.message, `${where}: "message"`) }),
      ...(r.source === undefined ? {} : { source: compile(r.source, `${where}: "source"`) }),
      ...(r.level === undefined ? {} : { level: r.level as LogLevel }),
    };
  });
}

/** Project rules first, then every default the project did not replace by `id`. */
export function withDefaultRules(project: readonly LogClassRule[]): LogClassRule[] {
  const ids = new Set(project.map((r) => r.id));
  return [...project, ...DEFAULT_LOG_CLASS_RULES.filter((d) => !ids.has(d.id))];
}

/** Reads and validates one classes file. A missing file is "no project rules". */
export function readLogClassesFile(path: string): LogClassRule[] {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    if (isRecord(e) && e.code === "ENOENT") return [];
    throw new LogClassesError(`cannot read ${path}: ${e instanceof Error ? e.message : String(e)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new LogClassesError(`${path} is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  return parseLogClasses(parsed, path);
}

/** The project's `.jevitate/log-classes.json` (found as `.jevitate/` is), or `null` outside a project. */
export function logClassesFilePath(deps: LayoutDeps = {}): string | null {
  const dir = findProjectDir(deps);
  return dir === null ? null : join(dir, LOG_CLASSES_FILE);
}

/**
 * The rules a run classifies its `--log-defect` lines with: the project's file (when there is one,
 * validated — throws `LogClassesError`) ahead of the built-in defaults.
 */
export function loadLogClassRules(deps: LayoutDeps = {}): LogClassRule[] {
  const path = logClassesFilePath(deps);
  return withDefaultRules(path === null ? [] : readLogClassesFile(path));
}

/** The first rule matching a line, or `undefined` (the line keeps the oracle's own verdict: a defect). */
export function classifyLogLine(rules: readonly LogClassRule[], line: Pick<LogLine, "message" | "source" | "level">): LogClassRule | undefined {
  return rules.find(
    (r) =>
      (r.level === undefined || r.level === line.level) &&
      (r.source === undefined || r.source.test(line.source)) &&
      (r.message === undefined || r.message.test(line.message)),
  );
}
