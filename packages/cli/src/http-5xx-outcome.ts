import type { GoalBasedOutcome, Http5xxDefect } from "@jevitate/explore";

/**
 * How an HTTP 5xx hard-signal defect (#208, `Http5xxOracle`) folds into a run's outcome — the same
 * rule a `server-log` defect follows (#142):
 *
 *  - coverage/exploratory and feature runs count it with their own defects (a found defect wins
 *    over a thin run's `inconclusive`, exactly like a declared-invariant defect);
 *  - a goal run's own `GoalBasedOutcome`: `defects-found` over `succeeded` / `exhausted` /
 *    `blocked`. A goal whose checks held but whose run hit a server error is NOT a success: the
 *    checks' verdict stays on the result (`assertionPassed`, `checks`), and `reason` says both.
 *    A broken run (`inconclusive` / `crashed`) and a hang keep their outcome; the defect is still
 *    listed in `defects`, and `reason` names it.
 */
const BROKEN_GOAL_OUTCOMES: ReadonlySet<GoalBasedOutcome> = new Set(["inconclusive", "crashed", "hang", "intermittent"]);

export function applyHttp5xxGoalOutcome(outcome: GoalBasedOutcome, defects: readonly Http5xxDefect[]): GoalBasedOutcome {
  return defects.length > 0 && !BROKEN_GOAL_OUTCOMES.has(outcome) ? "defects-found" : outcome;
}

/** `PUT /api/profile → 500` for each defect (first three), for a one-line `reason`. */
export function describeHttp5xx(defects: readonly Http5xxDefect[]): string {
  const shown = defects.slice(0, 3).map((d) => {
    const s = d.signals[0];
    let path = s?.url ?? d.route;
    try {
      path = new URL(path).pathname;
    } catch {
      /* keep the raw (redacted) url */
    }
    return `${d.method} ${path} → ${s?.status ?? "5xx"}`;
  });
  const more = defects.length > 3 ? ` (+${defects.length - 3} more)` : "";
  return `${shown.join(", ")}${more}`;
}

/** The `reason` of a goal run that `applyHttp5xxGoalOutcome` turned into `defects-found`. */
export function http5xxGoalReason(defects: readonly Http5xxDefect[], assertionPassed: boolean): string {
  const n = defects.length;
  const found = `${n} HTTP 5xx defect${n === 1 ? "" : "s"} found: ${describeHttp5xx(defects)}`;
  return assertionPassed ? `${found} — the goal's success checks held, but the app answered with a server error` : found;
}
