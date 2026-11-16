// explore-goal-server-cause.ts — the goal run's correlated server-cause prose (#165/#204).

import type { GoalBasedOutcome } from "@jevitate/explore";
import type { MissionOutcome } from "@jevitate/domain";
import type { ServerLogEvidence, ServerLogRuntimeResult, TranscriptEntryWithLogs } from "./log-correlation.js";

/** One-line reason for a server-log-driven outcome change (`reason` is unset otherwise for `succeeded`). */
export function serverLogOutcomeReason(newOutcome: GoalBasedOutcome | MissionOutcome, run: ServerLogRuntimeResult | undefined): string {
  if (newOutcome === "defects-found") {
    const n = run?.defects.length ?? 0;
    return `${n} server-log defect${n === 1 ? "" : "s"} found (--log-defect)`;
  }
  // #169: the summary already knows WHICH source(s) failed to attach and their error text — this
  // default only covers the (should-be-unreachable) case of no summary at all.
  return (
    run?.summary.oracleReason ??
    "the --log-defect oracle could not run: every declared --log-source failed to attach — an absence of server-log defects proves nothing"
  );
}

/** Outcomes whose `reason` describes a UI-side blocker worth pairing with a correlated server cause. */
const BLOCKED_LIKE_OUTCOMES: ReadonlySet<GoalBasedOutcome> = new Set(["blocked", "exhausted", "failed", "inconclusive"]);

const SERVER_CAUSE_MAX_CHARS = 160;
/** Decisions that end a run without acting on the page (their state is the previous action's). */
const ENDING_OPS: ReadonlySet<string> = new Set(["blocked", "done", "report"]);

/**
 * The most informative correlated server-log line attached to the LAST transcript step (#165's
 * "Also" — the step the run ended on is the one whose UI blocker `mission.reason` already
 * describes): an `error` line wins over a `warn` one; ties keep the first (arrival order). `undefined`
 * when `--log-source` was not given, or nothing warn/error-level attached to that step.
 */
function lastStepServerCause(transcript: readonly TranscriptEntryWithLogs[] | undefined): { readonly text: string; readonly correlated: boolean } | undefined {
  // The step the run ended on: the last entry — and, when the run ended on a decision that acts on
  // nothing (`blocked`, `done`, `report`), the action just before it too, whose UI state that
  // decision is about (#204: its request's lines are attached to it).
  const logs: ServerLogEvidence[] = [];
  for (let i = (transcript?.length ?? 0) - 1; i >= 0; i--) {
    const e = transcript?.[i];
    if (e === undefined) break;
    logs.push(...(e.serverLogs ?? []));
    if (e.op === null || !ENDING_OPS.has(e.op)) break;
  }
  if (logs.length === 0) return undefined;
  // An error beats a warn; at the same level, a line correlated to its exact request by id (#204)
  // beats one attached by time; ties keep the first (arrival order).
  const rank = (l: ServerLogEvidence): number => (l.level === "error" ? 2 : 0) + (l.request === undefined ? 0 : 1);
  let line: ServerLogEvidence | undefined;
  for (const l of logs) {
    if (l.level !== "error" && l.level !== "warn") continue;
    if (line === undefined || rank(l) > rank(line)) line = l;
  }
  if (line === undefined) return undefined;
  const body = line.message.length > SERVER_CAUSE_MAX_CHARS ? `${line.message.slice(0, SERVER_CAUSE_MAX_CHARS)}…` : line.message;
  const said = `${line.level}${line.target === undefined ? "" : ` ${line.target}`} ${quote(body)}`;
  if (line.request === undefined) return { text: said, correlated: false };
  const r = line.request;
  return { text: `${said} on ${r.method} ${pathOf(r.url)}${r.status === null ? "" : ` (${r.status})`}`, correlated: true };
}

/** A redacted request URL's path (the reason names the endpoint, never its query). */
function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url.split(/[?#]/)[0] ?? url;
  }
}

function quote(s: string): string {
  return `"${s}"`;
}

/**
 * Pairs an already-computed UI-side `reason` with the correlated server cause on the step the run
 * ended on (#165 "Also"): `"<UI reason>; server: <level> \"<message>\""` — or, when the line was
 * correlated to its exact request by a trace/correlation id (#204), `"<UI reason>; caused by:
 * <level> \"<message>\" on POST /x (500)"`. A no-op when there is no
 * `reason` to pair with, the outcome isn't one of blocked/exhausted/inconclusive (a `defects-found`
 * or an oracle-unhealthy `inconclusive` already gets its own `serverLogOutcomeReason`), or no
 * server-log evidence attached to that step — including when `--log-source` was never given.
 */
export function withServerCause(reason: string | undefined, outcome: GoalBasedOutcome, transcript: readonly TranscriptEntryWithLogs[] | undefined): string | undefined {
  if (reason === undefined || !BLOCKED_LIKE_OUTCOMES.has(outcome)) return reason;
  const cause = lastStepServerCause(transcript);
  if (cause === undefined) return reason;
  return `${reason}; ${cause.correlated ? "caused by" : "server"}: ${cause.text}`;
}
