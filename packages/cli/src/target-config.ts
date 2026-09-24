import { readFileSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import type { HangConfig, SettleConfig, TimingConfig } from "@jevitate/explore";
import { resolveDataDir } from "./data-dir.js";

/**
 * Per-target (per-origin) configuration — `~/.jevitate/targets.json`:
 *
 * ```json
 * { "https://app.example.test": {
 *     "settle": { "ignoreRequests": ["/api/notifications/poll*", "/hub/*"], "longPollMs": 5000 },
 *     "hangs": { "ignoreNoProgress": ["click Refresh*", "/dashboard"] },
 *     "timing": { "apiPrefixes": ["/api/", "/graphql"] } } }
 * ```
 *
 * `settle.ignoreRequests` — requests the target marks as background (never in-flight work);
 * `settle.longPollMs` — long-poll auto-detection threshold; `hangs.ignoreNoProgress` — routes,
 * action labels or busy indicators where `ui-no-progress` is expected. CLI flags (`--settle-ignore`,
 * `--long-poll-ms`, `--ignore-no-progress`) add to / override the file for one run. A missing file
 * is "no target config"; a malformed one fails closed.
 *
 * `fixtures` — a mission fixtures file (#140/#144) for goal runs on this origin when `--fixtures`
 * is absent; a relative path resolves against the targets file's directory.
 */

export interface TargetConfig {
  readonly settle?: SettleConfig;
  readonly hangs?: HangConfig;
  readonly timing?: TimingConfig;
  /** Mission fixtures file (#140/#144), absolute. */
  readonly fixtures?: string;
}

export class TargetConfigError extends Error {
  readonly code = "E_TARGET_CONFIG" as const;
}

function strings(v: unknown, where: string): string[] {
  if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) {
    throw new TargetConfigError(`${where} must be an array of strings`);
  }
  return v;
}

function parseTarget(v: unknown, where: string, baseDir: string): TargetConfig {
  if (v === null || typeof v !== "object" || Array.isArray(v)) throw new TargetConfigError(`${where} must be an object`);
  const o = v as Record<string, unknown>;
  const out: { settle?: SettleConfig; hangs?: HangConfig; timing?: TimingConfig; fixtures?: string } = {};
  if (o.fixtures !== undefined) {
    if (typeof o.fixtures !== "string" || o.fixtures === "") throw new TargetConfigError(`${where}.fixtures must be a file path`);
    out.fixtures = resolvePath(baseDir, o.fixtures);
  }
  if (o.settle !== undefined) {
    if (o.settle === null || typeof o.settle !== "object") throw new TargetConfigError(`${where}.settle must be an object`);
    const s = o.settle as Record<string, unknown>;
    const settle: { ignoreRequests?: string[]; longPollMs?: number } = {};
    if (s.ignoreRequests !== undefined) settle.ignoreRequests = strings(s.ignoreRequests, `${where}.settle.ignoreRequests`);
    if (s.longPollMs !== undefined) {
      if (typeof s.longPollMs !== "number" || !(s.longPollMs > 0)) {
        throw new TargetConfigError(`${where}.settle.longPollMs must be a positive number`);
      }
      settle.longPollMs = s.longPollMs;
    }
    out.settle = settle;
  }
  if (o.hangs !== undefined) {
    if (o.hangs === null || typeof o.hangs !== "object") throw new TargetConfigError(`${where}.hangs must be an object`);
    const h = o.hangs as Record<string, unknown>;
    out.hangs = h.ignoreNoProgress === undefined ? {} : { ignoreNoProgress: strings(h.ignoreNoProgress, `${where}.hangs.ignoreNoProgress`) };
  }
  if (o.timing !== undefined) {
    if (o.timing === null || typeof o.timing !== "object") throw new TargetConfigError(`${where}.timing must be an object`);
    const t = o.timing as Record<string, unknown>;
    out.timing = t.apiPrefixes === undefined ? {} : { apiPrefixes: strings(t.apiPrefixes, `${where}.timing.apiPrefixes`) };
  }
  return out;
}

/** Reads the whole targets file, keyed by origin. */
export function loadTargetsFile(path = resolveDataDir(["targets.json"])): Readonly<Record<string, TargetConfig>> {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    if (typeof e === "object" && e !== null && "code" in e && e.code === "ENOENT") return {};
    throw new TargetConfigError(`cannot read ${path}: ${e instanceof Error ? e.message : String(e)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new TargetConfigError(`${path} is not valid JSON`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new TargetConfigError(`${path} must be an object keyed by origin`);
  }
  const out: Record<string, TargetConfig> = {};
  for (const [origin, v] of Object.entries(parsed as Record<string, unknown>)) out[origin] = parseTarget(v, `${path}[${origin}]`, dirname(path));
  return out;
}

export interface TargetFlags {
  readonly settleIgnore?: readonly string[];
  readonly longPollMs?: number;
  readonly ignoreNoProgress?: readonly string[];
  readonly apiPrefixes?: readonly string[];
}

/** The config for one origin: the file's entry, with flag patterns ADDED and flag numbers winning. */
export function resolveTargetConfig(
  file: Readonly<Record<string, TargetConfig>>,
  origin: string,
  flags: TargetFlags = {},
): TargetConfig {
  const base = file[origin] ?? {};
  const ignoreRequests = [...(base.settle?.ignoreRequests ?? []), ...(flags.settleIgnore ?? [])];
  const longPollMs = flags.longPollMs ?? base.settle?.longPollMs;
  const ignoreNoProgress = [...(base.hangs?.ignoreNoProgress ?? []), ...(flags.ignoreNoProgress ?? [])];
  const apiPrefixes = [...(base.timing?.apiPrefixes ?? []), ...(flags.apiPrefixes ?? [])];
  return {
    timing: apiPrefixes.length === 0 ? {} : { apiPrefixes },
    settle: { ...(ignoreRequests.length === 0 ? {} : { ignoreRequests }), ...(longPollMs === undefined ? {} : { longPollMs }) },
    hangs: ignoreNoProgress.length === 0 ? {} : { ignoreNoProgress },
    ...(base.fixtures === undefined ? {} : { fixtures: base.fixtures }),
  };
}
