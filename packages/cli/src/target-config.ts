import { readFileSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import type { HangConfig, SafetyConfig, SettleConfig, TimingConfig } from "@jevitate/explore";
import { resolveDataDir } from "./data-dir.js";

/**
 * Per-target (per-origin) configuration — `~/.jevitate/targets.json`:
 *
 * ```json
 * { "https://app.example.test": {
 *     "settle": { "ignoreRequests": ["/api/notifications/poll*", "/hub/*"], "longPollMs": 5000 },
 *     "hangs": { "ignoreNoProgress": ["click Refresh*", "/dashboard"] },
 *     "timing": { "apiPrefixes": ["/api/", "/graphql"] },
 *     "safety": { "deny": ["/^Archive/"], "allowDestructive": false, "readRequests": ["Estimate*", "/api/search*"] } } }
 * ```
 *
 * `settle.ignoreRequests` — requests the target marks as background (never in-flight work);
 * `settle.longPollMs` — long-poll auto-detection threshold; `hangs.ignoreNoProgress` — routes,
 * action labels or busy indicators where `ui-no-progress` is expected; `safety` — the shared safety
 * policy (#116: `deny` controls, `allowDestructive`) and extra read requests for the write
 * classifier (#110: `readRequests`, RPC-method or path globs). CLI flags (`--settle-ignore`,
 * `--long-poll-ms`, `--ignore-no-progress`, `--deny`, `--allow-destructive`, `--read-rpc`) add to /
 * override the file for one run. A missing file
 * is "no target config"; a malformed one fails closed.
 *
 * `fixtures` — a mission fixtures file (#140/#144) for goal runs on this origin when `--fixtures`
 * is absent; a relative path resolves against the targets file's directory.
 */

export interface TargetConfig {
  readonly settle?: SettleConfig;
  readonly hangs?: HangConfig;
  readonly timing?: TimingConfig;
  readonly safety?: SafetyConfig;
  /** Mission fixtures file (#140/#144), absolute. */
  readonly fixtures?: string;
  /**
   * Backend log sources (#142 follow-up): raw `--log-source` specs (`file:`/`docker:`/`cmd:`), used
   * by missions drained from the queue (`jevitate mission run`) and by `verify_fix` over MCP — a
   * caller-supplied `MissionRequest`/tool argument may NEVER name a path or a command, so a source
   * is only ever declared here, by the operator, local to this machine.
   */
  readonly logSources?: readonly string[];
  /** Raw `--log-defect` specs (a level or a `/regex/`), evaluated the same way as the CLI flag. */
  readonly logDefect?: readonly string[];
  /** Opt-in for a `cmd:` source in `logSources` (mirrors `--allow-log-cmd`). Default `false`. */
  readonly allowLogCmd?: boolean;
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
  const out: {
    settle?: SettleConfig;
    hangs?: HangConfig;
    timing?: TimingConfig;
    safety?: SafetyConfig;
    fixtures?: string;
    logSources?: string[];
    logDefect?: string[];
    allowLogCmd?: boolean;
  } = {};
  if (o.fixtures !== undefined) {
    if (typeof o.fixtures !== "string" || o.fixtures === "") throw new TargetConfigError(`${where}.fixtures must be a file path`);
    out.fixtures = resolvePath(baseDir, o.fixtures);
  }
  if (o.logSources !== undefined) out.logSources = strings(o.logSources, `${where}.logSources`);
  if (o.logDefect !== undefined) out.logDefect = strings(o.logDefect, `${where}.logDefect`);
  if (o.allowLogCmd !== undefined) {
    if (typeof o.allowLogCmd !== "boolean") throw new TargetConfigError(`${where}.allowLogCmd must be a boolean`);
    out.allowLogCmd = o.allowLogCmd;
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
  if (o.safety !== undefined) {
    if (o.safety === null || typeof o.safety !== "object") throw new TargetConfigError(`${where}.safety must be an object`);
    const f = o.safety as Record<string, unknown>;
    if (f.allowDestructive !== undefined && typeof f.allowDestructive !== "boolean") {
      throw new TargetConfigError(`${where}.safety.allowDestructive must be a boolean`);
    }
    if (f.allowWrites !== undefined && typeof f.allowWrites !== "boolean" && !Array.isArray(f.allowWrites)) {
      throw new TargetConfigError(`${where}.safety.allowWrites must be a boolean or an array of path globs`);
    }
    if (f.hangReplayWrites !== undefined && typeof f.hangReplayWrites !== "boolean") {
      throw new TargetConfigError(`${where}.safety.hangReplayWrites must be a boolean`);
    }
    out.safety = {
      ...(f.deny === undefined ? {} : { deny: strings(f.deny, `${where}.safety.deny`) }),
      ...(f.allowDestructive === undefined ? {} : { allowDestructive: f.allowDestructive as boolean }),
      ...(typeof f.allowWrites === "boolean" ? { allowWrites: f.allowWrites } : {}),
      ...(Array.isArray(f.allowWrites) ? { allowWriteRequests: strings(f.allowWrites, `${where}.safety.allowWrites`) } : {}),
      ...(f.hangReplayWrites === undefined ? {} : { hangReplayWrites: f.hangReplayWrites as boolean }),
      ...(f.readRequests === undefined ? {} : { readRequests: strings(f.readRequests, `${where}.safety.readRequests`) }),
    };
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
  /** `--deny` patterns (added to the file's). */
  readonly deny?: readonly string[];
  /** `--allow-destructive` (true wins over the file). */
  readonly allowDestructive?: boolean;
  /** `--allow-writes` (true wins over the file, #158). */
  readonly allowWrites?: boolean;
  /** `--allow-write` path globs (added to the file's `safety.allowWrites` globs, #158). */
  readonly allowWrite?: readonly string[];
  /** `--read-rpc` patterns (added to the file's `safety.readRequests`). */
  readonly readRpc?: readonly string[];
  /** `--hang-replay-writes` (#153; true wins over the file). */
  readonly hangReplayWrites?: boolean;
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
  const deny = [...(base.safety?.deny ?? []), ...(flags.deny ?? [])];
  const readRequests = [...(base.safety?.readRequests ?? []), ...(flags.readRpc ?? [])];
  const allowDestructive = flags.allowDestructive === true || base.safety?.allowDestructive === true;
  const allowWrites = flags.allowWrites === true || base.safety?.allowWrites === true;
  const allowWriteRequests = [...(base.safety?.allowWriteRequests ?? []), ...(flags.allowWrite ?? [])];
  const hangReplayWrites = flags.hangReplayWrites === true || base.safety?.hangReplayWrites === true;
  const safety: SafetyConfig = {
    ...(deny.length === 0 ? {} : { deny }),
    ...(readRequests.length === 0 ? {} : { readRequests }),
    ...(allowDestructive ? { allowDestructive } : {}),
    ...(allowWrites ? { allowWrites } : {}),
    ...(allowWriteRequests.length === 0 ? {} : { allowWriteRequests }),
    ...(hangReplayWrites ? { hangReplayWrites } : {}),
  };
  return {
    ...(Object.keys(safety).length === 0 ? {} : { safety }),
    timing: apiPrefixes.length === 0 ? {} : { apiPrefixes },
    settle: { ...(ignoreRequests.length === 0 ? {} : { ignoreRequests }), ...(longPollMs === undefined ? {} : { longPollMs }) },
    hangs: ignoreNoProgress.length === 0 ? {} : { ignoreNoProgress },
    ...(base.fixtures === undefined ? {} : { fixtures: base.fixtures }),
    // #142 follow-up: pass-through only — no CLI flag merges into these (a `--log-source` on the
    // command line is already handled by the caller; this is purely the operator's file-declared
    // default for callers that have none of their own, i.e. the queue drain and verify_fix over MCP).
    ...(base.logSources === undefined ? {} : { logSources: base.logSources }),
    ...(base.logDefect === undefined ? {} : { logDefect: base.logDefect }),
    ...(base.allowLogCmd === undefined ? {} : { allowLogCmd: base.allowLogCmd }),
  };
}
