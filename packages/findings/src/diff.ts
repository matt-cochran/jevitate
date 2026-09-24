import { consolidate, type ConsolidatedDefect } from "./consolidate.js";
import type { RunRecord } from "./extract.js";
import type { RunMode } from "./identity.js";

/**
 * Baseline diff (#138): every finding of the baseline runs and the current runs, matched by the
 * shared finding identity, classified as
 *
 *  - `new`           — not seen in any baseline run, seen in every comparable current run;
 *  - `resolved`      — seen in every comparable baseline run, in no current run;
 *  - `still-present` — seen in every comparable run on both sides;
 *  - `flaky`         — seen in some but not all comparable runs of a side (or a run itself saw it
 *                      come and go: a hang reproduced k/N, verify-fix `intermittent`);
 *  - `not-rerun`     — a baseline finding no current run could have seen (no current run of a mode
 *                      that observed it): never reported `resolved` without evidence.
 *
 * "Comparable" runs are the runs of the modes that observed the finding at all: a goal run cannot
 * see an adversarial-only defect, so its silence is not evidence that the defect went away.
 * `inBaseline` is kept separately, so a gate on "not in the baseline" (CI mode) never lets a new
 * flaky finding through just because it is flaky.
 */

export type DiffStatus = "new" | "resolved" | "still-present" | "flaky" | "not-rerun";

export const DIFF_STATUSES: readonly DiffStatus[] = ["new", "resolved", "still-present", "flaky", "not-rerun"];

export interface SideCount {
  /** Comparable runs on this side that observed it. */
  readonly seen: number;
  /** Comparable runs on this side (the runs of the modes that observed it). */
  readonly of: number;
}

export interface DiffEntry {
  readonly key: string;
  readonly status: DiffStatus;
  readonly inBaseline: boolean;
  readonly inCurrent: boolean;
  readonly baseline: SideCount;
  readonly current: SideCount;
  readonly defect: ConsolidatedDefect;
}

export interface FindingsDiff {
  readonly entries: readonly DiffEntry[];
  readonly summary: Readonly<Record<DiffStatus, number>>;
  readonly baselineRuns: readonly string[];
  readonly currentRuns: readonly string[];
}

function side(defect: ConsolidatedDefect, runs: readonly RunRecord[], modes: ReadonlySet<RunMode>): SideCount {
  const observed = new Set(defect.modes.flatMap((m) => m.runs.map((r) => r.path)));
  const comparable = runs.filter((r) => modes.has(r.mode));
  return { seen: comparable.filter((r) => observed.has(r.path)).length, of: comparable.length };
}

/** The pure classification rule over one finding's two sides. */
export function classify(baseline: SideCount, current: SideCount, intermittent: boolean): DiffStatus {
  const inBase = baseline.seen > 0;
  const inCur = current.seen > 0;
  const partial = (s: SideCount): boolean => s.seen > 0 && s.seen < s.of;
  if (inBase && current.of === 0) return "not-rerun";
  if (intermittent || partial(baseline) || partial(current)) return "flaky";
  if (inBase && inCur) return "still-present";
  if (inCur) return "new";
  return "resolved";
}

/**
 * Diffs `current` against `baseline`. A run (identified by its result file) present on both sides
 * counts only as current.
 */
export function diffRuns(baseline: readonly RunRecord[], current: readonly RunRecord[]): FindingsDiff {
  const currentPaths = new Set(current.map((r) => r.path));
  const base = baseline.filter((r) => !currentPaths.has(r.path));
  const entries = consolidate([...base, ...current]).map((defect): DiffEntry => {
    const modes = new Set(defect.modes.map((m) => m.mode));
    const b = side(defect, base, modes);
    const c = side(defect, current, modes);
    return {
      key: defect.key,
      status: classify(b, c, defect.intermittent),
      inBaseline: b.seen > 0,
      inCurrent: c.seen > 0,
      baseline: b,
      current: c,
      defect,
    };
  });
  const summary = { new: 0, resolved: 0, "still-present": 0, flaky: 0, "not-rerun": 0 } as Record<DiffStatus, number>;
  for (const e of entries) summary[e.status] += 1;
  return { entries, summary, baselineRuns: base.map((r) => r.runId), currentRuns: current.map((r) => r.runId) };
}
