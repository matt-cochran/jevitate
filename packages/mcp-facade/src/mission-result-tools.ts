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
 * A mission result id is the artifact stem the CLI wrote (`adversarial-2026-09-23T00-00-00-000Z`,
 * `coverage-…`). Only that shape is accepted, so an id can never become a path traversal.
 */
const RESULT_ID = /^(adversarial|coverage)-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/;

export function isMissionResultId(id: unknown): id is string {
  return typeof id === "string" && RESULT_ID.test(id);
}
