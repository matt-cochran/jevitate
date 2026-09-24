import { MISSION_EXIT_CODES, MISSION_OUTCOMES, isBrokenRun, type MissionOutcome } from "@jevitate/domain";

/**
 * The MCP surface for a mission's TYPED result. A mission never answers with a throw: every
 * ending — clean, defects found, hang, intermittent, inconclusive, crashed — is a status the
 * agent can branch on, carrying the same code the CLI exits with. `isError` is reserved for a
 * run that itself broke (inconclusive / crashed): its silence proves nothing, and an agent must
 * never mistake it for a pass.
 */
export interface McpMissionStatus {
  readonly status: MissionOutcome;
  /** The CLI exit code for this outcome (0 clean · 1 defects · 2 broken run · 3 hang · 4 intermittent). */
  readonly exitCode: number;
  readonly isError: boolean;
}

export function missionStatus(outcome: MissionOutcome): McpMissionStatus {
  return { status: outcome, exitCode: MISSION_EXIT_CODES[outcome], isError: isBrokenRun(outcome) };
}

/** Narrows an unknown value (e.g. read from a result file) to a `MissionOutcome`, or null. */
export function parseMissionOutcome(value: unknown): MissionOutcome | null {
  return typeof value === "string" && (MISSION_OUTCOMES as readonly string[]).includes(value)
    ? (value as MissionOutcome)
    : null;
}

/**
 * A goal run (`explore-<stamp>`) persists its OWN outcome (`succeeded`/`exhausted`/`blocked`, or a
 * shared one) as its result's `missionOutcome` (#117). Folded onto the canonical outcome with the
 * same exit code the CLI uses: `succeeded` → clean (0); `exhausted`/`blocked` — the goal's success
 * check did not hold — → defects-found (1). The goal's own word is kept as `goalOutcome`.
 */
const GOAL_OUTCOMES: Readonly<Record<string, MissionOutcome>> = {
  succeeded: "clean",
  exhausted: "defects-found",
  blocked: "defects-found",
};

/** Narrows a persisted result's `missionOutcome` (canonical, or a goal run's own) to a status, or null. */
export function parseResultOutcome(value: unknown): { outcome: MissionOutcome; goalOutcome?: string } | null {
  const canonical = parseMissionOutcome(value);
  if (canonical !== null) return { outcome: canonical };
  if (typeof value === "string" && Object.hasOwn(GOAL_OUTCOMES, value)) {
    return { outcome: GOAL_OUTCOMES[value]!, goalOutcome: value };
  }
  return null;
}

/**
 * A mission result id is the artifact stem the CLI wrote — one per strategy (#117):
 * `explore-<stamp>` (goal), `coverage-<stamp>` (coverage/exploratory), `adversarial-<stamp>`,
 * `feature-<stamp>`, and a usability review's `usability-<stamp>.recording` (its result sits next to
 * its Recording; the report stem `usability-<stamp>` is accepted as an alias). Only these closed
 * shapes are accepted — no separator, no `..`, nothing caller-shaped — so an id can never become a
 * path traversal.
 */
const RESULT_ID =
  /^(?:(?:explore|coverage|adversarial|feature)-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z|usability-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z(?:\.recording)?)$/;

/** A `queue_exploration` missionId: a lowercase RFC 4122 uuid (what `enqueueMission` generates). */
const QUEUED_MISSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isMissionResultId(id: unknown): id is string {
  return typeof id === "string" && RESULT_ID.test(id);
}

/** True for a `queue_exploration` missionId — resolved to its result through the queue record once run. */
export function isQueuedMissionId(id: unknown): id is string {
  return typeof id === "string" && QUEUED_MISSION_ID.test(id);
}

/**
 * The result file a (validated) result id names: `<stem>.result.json`, with a usability report stem
 * mapped onto its Recording's (`usability-<stamp>` → `usability-<stamp>.recording.result.json`).
 * Throws for anything that is not a valid result id — the file name is never caller-shaped.
 */
export function missionResultFileName(id: string): string {
  if (!isMissionResultId(id)) throw new Error("not a mission result id");
  const stem = id.startsWith("usability-") && !id.endsWith(".recording") ? `${id}.recording` : id;
  return `${stem}.result.json`;
}
