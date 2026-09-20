/**
 * Thrown by `MissionTargetRegistry.resolve` for a target id that either does
 * not exist or exists but is not promoted. Deliberately non-distinguishing
 * (same error/message for both cases) — mirrors `runJourney`'s "unknown or
 * unpublished journey" refusal, so an untrusted caller can't enumerate which
 * target ids exist by observing a different failure mode.
 */
export class UnknownOrUnpromotedMissionTargetError extends Error {}

/**
 * Thrown by `enqueueMission` when a provided `budget` field exceeds
 * `MISSION_BOUNDS_CEILING`. The ceiling is a hard ceiling, never a default
 * with headroom above it — an over-ceiling request is refused before any
 * target resolution or disk write, never silently clamped down.
 */
export class BudgetExceedsCeilingError extends Error {}
