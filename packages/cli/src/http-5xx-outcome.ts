import type { Http5xxDefect } from "@jevitate/explore";

/**
 * How an HTTP 5xx hard-signal defect (#208, `Http5xxOracle`) is worded on a run's `reason`. It
 * counts like every other defect: coverage/exploratory and feature runs with their own defects, and
 * a goal run through `defectOutcome` — `goalMissionOutcome` (#423) makes a `succeeded` goal
 * `defects-found` while its `goalOutcome` stays the goal's own (`assertionPassed`/`checks` too).
 */
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

/** The `reason` of a goal run whose only finding is an HTTP 5xx (#208). */
export function http5xxGoalReason(defects: readonly Http5xxDefect[], assertionPassed: boolean): string {
  const n = defects.length;
  const found = `${n} HTTP 5xx defect${n === 1 ? "" : "s"} found: ${describeHttp5xx(defects)}`;
  return assertionPassed ? `${found} — the goal's success checks held, but the app answered with a server error` : found;
}
