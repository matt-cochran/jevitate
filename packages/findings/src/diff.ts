import { consolidate, type ConsolidatedDefect } from "./consolidate.js";
import type { RunRecord } from "./extract.js";
import { routeTemplate } from "./identity.js";

/**
 * Baseline diff (#138, #171): every finding of the baseline runs and the current runs, matched by
 * the shared finding identity, classified as
 *
 *  - `new`           — in no comparable baseline run, in at least one comparable current run (its
 *                      recurrence ratio is reported beside it; it is never relabelled `flaky`);
 *  - `resolved`      — in comparable baseline runs and in none of the comparable current runs,
 *                      with enough of those that its baseline rate would have shown it;
 *  - `still-present` — in every comparable run on both sides;
 *  - `flaky`         — on both sides but not in every comparable run of one (or a run itself saw it
 *                      come and go: a hang reproduced k/N, verify-fix `intermittent`), or absent
 *                      from too few comparable current runs to call it resolved at its baseline rate;
 *  - `not-rerun`     — a baseline finding no current run could have seen: never `resolved` without
 *                      evidence.
 *
 * "Comparable" (#171): a run is evidence about a finding only when it could have observed it — the
 * same mode, target and mission settings (goal, route scope, feature, Journey; see `RunScope`) as a
 * run that DID observe it and, when both are known, a run that reached the finding's route. An
 * adversarial run on `/settings` says nothing about `/admin`, and a goal run for another goal says
 * nothing about this goal's failed check. Records without a scope (older results and baseline
 * tags) compare by mode and target only.
 *
 * `inBaseline` is kept separately, so a gate on "not in the baseline" (CI mode) never lets a new
 * flaky finding through.
 */

export type DiffStatus = "new" | "resolved" | "still-present" | "flaky" | "not-rerun";

export const DIFF_STATUSES: readonly DiffStatus[] = ["new", "resolved", "still-present", "flaky", "not-rerun"];

export interface SideCount {
  /** Comparable runs on this side that observed it. */
  readonly seen: number;
  /** Comparable runs on this side (the runs that could have observed it). */
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

function sameWhenKnown(a: string | undefined, b: string | undefined): boolean {
  return a === undefined || b === undefined || a === b;
}

/** Could `run` have observed what `observer` observed? The same mode, target and mission settings. */
export function sameScope(run: RunRecord, observer: RunRecord): boolean {
  return (
    run.mode === observer.mode &&
    sameWhenKnown(run.target, observer.target) &&
    sameWhenKnown(run.targetName, observer.targetName) &&
    sameWhenKnown(run.scope?.settings, observer.scope?.settings)
  );
}

/** Did `run` reach `route`? Unknown (no route, or no recorded routes) counts as yes. */
function reached(run: RunRecord, route: string | undefined): boolean {
  const routes = run.scope?.routes;
  if (route === undefined || routes === undefined || routes.length === 0) return true;
  return routes.includes(route);
}

function side(runs: readonly RunRecord[], observers: readonly RunRecord[], observed: ReadonlySet<string>, route: string | undefined): SideCount {
  const comparable = runs.filter((r) => observed.has(r.path) || (observers.some((o) => sameScope(r, o)) && reached(r, route)));
  return { seen: comparable.filter((r) => observed.has(r.path)).length, of: comparable.length };
}

/** The pure classification rule over one finding's two sides. */
export function classify(baseline: SideCount, current: SideCount, intermittent: boolean): DiffStatus {
  const partial = (s: SideCount): boolean => s.seen > 0 && s.seen < s.of;
  if (baseline.seen === 0) return "new";
  if (current.of === 0) return "not-rerun";
  if (current.seen === 0) {
    // At the baseline rate, would the comparable current runs have shown it at least once?
    return current.of * (baseline.seen / baseline.of) >= 1 ? "resolved" : "flaky";
  }
  if (intermittent || partial(baseline) || partial(current)) return "flaky";
  return "still-present";
}

/**
 * Diffs `current` against `baseline`. A run (identified by its result file) present on both sides
 * counts only as current.
 */
export function diffRuns(baseline: readonly RunRecord[], current: readonly RunRecord[]): FindingsDiff {
  const currentPaths = new Set(current.map((r) => r.path));
  const base = baseline.filter((r) => !currentPaths.has(r.path));
  const all = [...base, ...current];
  const entries = consolidate(all).map((defect): DiffEntry => {
    const observed = new Set(defect.modes.flatMap((m) => m.runs.map((r) => r.path)));
    const observers = all.filter((r) => observed.has(r.path));
    // A merged defect (several keys) may span routes: only a single-identity finding is route-bound.
    const route = defect.keys.length === 1 ? routeTemplate(defect.identity.route) : undefined;
    const b = side(base, observers, observed, route);
    const c = side(current, observers, observed, route);
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
