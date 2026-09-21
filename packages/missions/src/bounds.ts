/**
 * Hard ceiling for a mission's budget — never a default with headroom above
 * it. `enqueueMission` refuses (`BudgetExceedsCeilingError`) any provided
 * budget field exceeding these values rather than clamping down to them; an
 * omitted budget field defaults to the ceiling value itself.
 *
 * Recommended future direction (see plan's Risks section): once
 * `@jevitate/explore` exists, its `bounds.ts` should import this constant
 * rather than redefining its own numeric defaults, making `@jevitate/missions`
 * the single source of truth.
 */
export const MISSION_BOUNDS_CEILING = {
  maxActions: 60,
  maxDecisions: 120,
  maxCandidates: 250,
} as const;

export type Budget = {
  maxActions: number;
  maxDecisions: number;
  maxCandidates: number;
};
