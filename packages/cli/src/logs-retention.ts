import { readFileSync, readdirSync, rmSync, rmdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { resolveDataDir } from "./data-dir.js";
import { clock } from "@jevitate/domain";
import { isLiveVerifyReceipt } from "./journey-verify-checkpoint.js";

/**
 * Retention for run output under `.jevitate/logs/<date>/` (0.2.0): a run older than `ttlDays` is
 * deleted, but the newest `keepLatest` runs are always kept, so a quiet project is never wiped.
 * A run is every file and folder sharing its artifact stem (`explore-2026-09-25T01-26-29-787Z.*`).
 * Pruned at the start of each command that writes logs, or on demand with `jevitate logs prune`.
 * Configured in `~/.jevitate/config.json`: `{ "logs": { "ttlDays": 14, "keepLatest": 50 } }`.
 */
export interface LogsRetention {
  readonly ttlDays: number;
  readonly keepLatest: number;
}

export const DEFAULT_LOGS_RETENTION: LogsRetention = { ttlDays: 14, keepLatest: 50 };

export class LogsConfigError extends Error {
  readonly code = "E_LOGS_CONFIG" as const;
}

/** The `logs` section of the config file; the defaults when the file or section is absent. A malformed value fails closed. */
export function loadLogsRetention(path = resolveDataDir(["config.json"])): LogsRetention {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    if (typeof e === "object" && e !== null && "code" in e && e.code === "ENOENT") return DEFAULT_LOGS_RETENTION;
    throw new LogsConfigError(`cannot read ${path}: ${e instanceof Error ? e.message : String(e)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new LogsConfigError(`${path} is not valid JSON`);
  }
  const logs = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>).logs : undefined;
  if (logs === undefined) return DEFAULT_LOGS_RETENTION;
  if (logs === null || typeof logs !== "object" || Array.isArray(logs)) throw new LogsConfigError(`${path}: "logs" must be an object`);
  const o = logs as Record<string, unknown>;
  const int = (k: "ttlDays" | "keepLatest"): number => {
    const v = o[k];
    if (v === undefined) return DEFAULT_LOGS_RETENTION[k];
    if (typeof v !== "number" || !Number.isInteger(v) || v < 0) throw new LogsConfigError(`${path}: logs.${k} must be a non-negative integer, got ${JSON.stringify(v)}`);
    return v;
  };
  return { ttlDays: int("ttlDays"), keepLatest: int("keepLatest") };
}

const RUN_KEY = /^([a-z][a-z-]*-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)/;

interface Run {
  readonly key: string;
  readonly paths: string[];
  readonly mtimeMs: number;
}

/** #787: a proof's durable progress: one receipt per Journey, replaced as the proof moves. */
const VERIFY_PROGRESS_DIR = "verify-progress";

/**
 * #787: the proof receipts under `logs/verify-progress/`, each its own run. A receipt whose verifier is
 * still live stays, however old (its proof may be mid-way). One that cannot be read is judged by age.
 */
function verifyProgressIn(root: string): Run[] {
  const dir = join(root, VERIFY_PROGRESS_DIR);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (e) {
    if (typeof e === "object" && e !== null && "code" in e && e.code === "ENOENT") return [];
    throw e;
  }
  return names.flatMap((name) => {
    const path = join(dir, name);
    return isLiveVerifyReceipt(path) ? [] : [{ key: `${VERIFY_PROGRESS_DIR}/${name}`, paths: [path], mtimeMs: statSync(path).mtimeMs }];
  });
}

function runsIn(root: string): { runs: Run[]; dateDirs: string[] } {
  let dates: string[];
  try {
    dates = readdirSync(root).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d));
  } catch (e) {
    if (typeof e === "object" && e !== null && "code" in e && e.code === "ENOENT") return { runs: [], dateDirs: [] };
    throw e;
  }
  const byKey = new Map<string, { paths: string[]; mtimeMs: number }>();
  for (const date of dates) {
    for (const name of readdirSync(join(root, date))) {
      const path = join(root, date, name);
      // 0.30.0: a run's evidence folder (`journey-evidence-<stamp>`) belongs to its `journey-run-<stamp>` record.
      const stem = (RUN_KEY.exec(name)?.[1] ?? name).replace(/^journey-evidence-/, "journey-run-");
      const key = `${date}/${stem}`;
      const run = byKey.get(key) ?? { paths: [], mtimeMs: 0 };
      run.paths.push(path);
      run.mtimeMs = Math.max(run.mtimeMs, statSync(path).mtimeMs);
      byKey.set(key, run);
    }
  }
  return { runs: [...byKey].map(([key, r]) => ({ key, ...r })), dateDirs: dates.map((d) => join(root, d)) };
}

export interface PruneReport {
  readonly root: string;
  /** Runs deleted (`<date>/<stem>`). */
  readonly removed: string[];
  readonly keptRuns: number;
}

/** Applies `retention` to the logs under `root`. `dryRun` reports what would go, deleting nothing. */
export function pruneLogs(root: string, retention: LogsRetention, opts: { readonly nowMs?: number; readonly dryRun?: boolean } = {}): PruneReport {
  const nowMs = opts.nowMs ?? clock.now();
  const { runs, dateDirs } = runsIn(root);
  const receipts = verifyProgressIn(root);
  const cutoff = nowMs - retention.ttlDays * 86_400_000;
  // Receipts keep their own `keepLatest`: a project's many proofs never crowd out its runs, or the reverse.
  const expired = (pool: readonly Run[]): Run[] => [...pool].sort((a, b) => b.mtimeMs - a.mtimeMs).slice(retention.keepLatest).filter((r) => r.mtimeMs < cutoff);
  const doomed = [...expired(runs), ...expired(receipts)];
  if (opts.dryRun !== true) {
    for (const r of doomed) for (const p of r.paths) rmSync(p, { recursive: true, force: true });
    for (const d of dateDirs) {
      if (readdirSync(d).length === 0) rmdirSync(d);
    }
  }
  return { root, removed: doomed.map((r) => r.key).sort(), keptRuns: runs.length + receipts.length - doomed.length };
}
