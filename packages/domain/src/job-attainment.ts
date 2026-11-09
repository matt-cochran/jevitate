/**
 * 0.30.0 (#800, design §3.1/§6.1) — did the user's job get done? A run's `job: { attainment, basis }`
 * is decided by code from the job's done check (a path-independent reading of the app's state, false
 * before the run and true after it, read back in a fresh session), never by a model:
 *
 *  - `achieved`     — the done check read false before the run and true after it.
 *  - `not-achieved` — the done check read false before and still false after (`failure.kind:
 *                     "done-check-failed"`): the steps may have passed, but the job did not happen.
 *  - `unverified`   — nothing decides it: no done check, a check already true before the run, a
 *                     reading that could not be taken, or a harness target that forces it. A pass
 *                     accepted by grounded judgment alone also reads `unverified`.
 */
export const JOB_ATTAINMENTS = ["achieved", "not-achieved", "unverified"] as const;
export type JobAttainment = (typeof JOB_ATTAINMENTS)[number];

/**
 * Why the attainment reads as it does (design §3.1 verdict table, §5.2 trust table):
 *
 *  - `done-check`      — before false; after decided it (`achieved` / `not-achieved`).
 *  - `already-true`    — before read true: the reading proves nothing either way (`unverified`).
 *  - `reading-unknown` — a before or after reading could not be taken (`unverified`).
 *  - `no-check`        — the run had no done check (none declared, or `--no-done-check`) (`unverified`).
 *  - `harness`         — the target's trust is `harness`, which forces `unverified`.
 */
export const JOB_BASES = ["done-check", "already-true", "reading-unknown", "no-check", "harness"] as const;
export type JobBasis = (typeof JOB_BASES)[number];

/**
 * Why a `reading-unknown` reading could not be taken (the adjudicator's `UnknownReason` tokens, code-made,
 * never a value): `session-unavailable` (no fresh session, or its navigation failed), `page-replaced`
 * (the page changed while it was read), `check-unevaluable` (the check could not be evaluated there:
 * an unbound placeholder, a URL off the origin, a target or response that could not be judged).
 */
export const JOB_UNKNOWN_REASONS = ["page-not-watched", "page-replaced", "session-unavailable", "check-unevaluable", "replay-stalled", "not-gathered", "replay-errored"] as const;
export type JobUnknownReason = (typeof JOB_UNKNOWN_REASONS)[number];

/** A run's job verdict (`result.job`), decided by the adjudicator. */
export interface JobVerdict {
  readonly attainment: JobAttainment;
  readonly basis: JobBasis;
  /** rc-030: with basis `reading-unknown`, why the reading could not be taken, when the surface knows. */
  readonly reason?: JobUnknownReason;
}

/**
 * `project.json` `doneCheckPolicy` (owner decision 3, 0.30.0): how a pass with `job.attainment:
 * "unverified"` exits.
 *
 *  - `require`  (default) — an unverified pass proves nothing about the job: exit 2 `inconclusive`.
 *  - `advisory` — the opt-out: an unverified pass keeps exit 0; the attainment is still reported.
 */
export const DONE_CHECK_POLICIES = ["require", "advisory"] as const;
export type DoneCheckPolicy = (typeof DONE_CHECK_POLICIES)[number];
export const DEFAULT_DONE_CHECK_POLICY: DoneCheckPolicy = "require";

/** True for a value `job.attainment` may hold. */
export function isJobAttainment(value: unknown): value is JobAttainment {
  return typeof value === "string" && (JOB_ATTAINMENTS as readonly string[]).includes(value);
}

/** True for a value `doneCheckPolicy` may hold. */
export function isDoneCheckPolicy(value: unknown): value is DoneCheckPolicy {
  return typeof value === "string" && (DONE_CHECK_POLICIES as readonly string[]).includes(value);
}
