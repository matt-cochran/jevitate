// calibration.ts — which app classes the grader's default confidence threshold (confidence.ts)
// has ANY evidence behind, and the caveat a report must carry when a target falls outside it
// (issue #97). `DEFAULT_MIN_CONFIDENCE` was measured once, on one tuning app (Preveti, appClass
// "consumer", via packages/cli/scripts/ux-quality). A follow-up multi-rater check against a
// DIFFERENT app in that same "consumer" class found weak grader/human agreement (Cohen's kappa in
// the 0.0-0.15 range — see packages/cli/scripts/ux-quality/README.md and its labels/ corpus). So
// even a same-appClass match below is NOT a calibration guarantee, only the best evidence on
// record; a class absent from this table has none at all. `buildReport` (report.ts) folds
// `calibrationCaveat()`'s result into the headline/caveats on every report — the grader's
// confidence label is advisory, and an uncalibrated (or weakly calibrated) target must never be
// presented as if the threshold generalized to it.
//
// Extend `CALIBRATION_KNOWN_APP_CLASSES` only when a real `grader-eval.mjs` multi-rater run over a
// `packages/cli/scripts/ux-quality/labels/<app>/` directory backs the `note`.
//
// #133: the same evidence decides whether the grader may FILTER by default. Until a class has a
// held-out, multi-rater kappa ≥ GRADER_FILTER_KAPPA_GATE off the tuning app, the default `--show`
// policy is every grade (grade.ts `defaultQualityPolicy`): findings are shown with their grade.

export interface CalibrationNote {
  readonly appClass: string;
  readonly note: string;
  /**
   * Cohen's kappa of the grader against ≥2 independent raters on a HELD-OUT set from an app OTHER
   * than the tuning app (#133). Absent = never measured. Only a value ≥ `GRADER_FILTER_KAPPA_GATE`
   * lets the grader filter findings by default for this class.
   */
  readonly heldOutKappa?: number;
}

/**
 * #133: the grader may suppress findings by default only once held-out, multi-rater agreement OFF
 * the tuning app reaches this kappa. Until then every finding is shown with its grade.
 */
export const GRADER_FILTER_KAPPA_GATE = 0.4;

export const CALIBRATION_KNOWN_APP_CLASSES: readonly CalibrationNote[] = [
  {
    appClass: "consumer",
    note:
      "tuning app only (Preveti; packages/cli/scripts/ux-quality/corpus/legacy-labels.json). A second, different app in the same class showed weak grader/human agreement (Cohen's kappa 0.0-0.15, issue #97) — treat this class as UNVERIFIED, not calibrated.",
    heldOutKappa: 0.15,
  },
];

/** Does calibration evidence let the grader filter findings by default for `appClass`? (#133) */
export function graderMayFilterByDefault(appClass: string | undefined): boolean {
  const kappa = calibrationNoteFor(appClass)?.heldOutKappa;
  return kappa !== undefined && kappa >= GRADER_FILTER_KAPPA_GATE;
}

/** #133: what every caveat says about the grader's role until calibration backs it. */
const NOT_FILTERING = `the quality grade is shown on each finding and does NOT hide findings by default (no held-out, multi-rater kappa ≥ ${GRADER_FILTER_KAPPA_GATE} off the tuning app yet); filter explicitly with --show actionable,relevant-minor`;

/** The known-app-class entry for `appClass` (case-insensitive), if any. */
export function calibrationNoteFor(appClass: string | undefined): CalibrationNote | undefined {
  if (!appClass) return undefined;
  const wanted = appClass.trim().toLowerCase();
  return CALIBRATION_KNOWN_APP_CLASSES.find((c) => c.appClass.toLowerCase() === wanted);
}

/**
 * The caveat `buildReport` should carry for `appClass` — ALWAYS present (never `undefined` for a
 * real app class), because no app class currently has verified calibration: a class in the table
 * has only weak, single-app evidence; a class absent from it has none. Only a blank/missing app
 * class short-circuits to the generic "no app class" wording.
 */
export function calibrationCaveat(appClass: string | undefined): string {
  const known = calibrationNoteFor(appClass);
  const role = graderMayFilterByDefault(appClass) ? "" : `; ${NOT_FILTERING}`;
  if (known) return `app class "${appClass}" calibration: ${known.note}${role}`;
  return appClass
    ? `app class "${appClass}" is outside the grader's calibration corpus — its confidence threshold and actionable/relevant-minor/generic/wrong labels are UNVERIFIED for this target (see packages/cli/scripts/ux-quality/README.md)${role}`
    : `no app class was given — the grader's confidence threshold is UNVERIFIED for this target (see packages/cli/scripts/ux-quality/README.md)${role}`;
}
