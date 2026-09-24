// confidence.ts — how a UX finding's confidence is computed, and the report cutoff.
//
// Jev is ADVISORY: its probabilities are one input, never the verdict. A finding's confidence
// is the product of four independent factors, each in [0,1]:
//
//   per occurrence i (one screen-state):
//     e_i = violation_i × applicability_i × grounding_i
//       violation_i     — Jev's probability the principle is VIOLATED, oriented by the flag rule
//                         (noul-false → 1−P(true); noul-true → P(true); score-below t →
//                         (t−v)/t; score-above t → (v−t)/(1−t); choice-in → choice confidence).
//                         The max over an entry's triggered questions.
//       applicability_i — Jev's P(the principle can sensibly be at issue on this screen type,
//                         job and app class). Entries whose deterministic `applicability` gate
//                         fails are never judged at all (coverage.notApplicable).
//       grounding_i     — from INDEPENDENT code adjudication of the specifics (adjudicate.ts):
//                         1.0 when the observation names a cited control or quotes verified text,
//                         GROUNDING_UNNAMED when evidence is cited but not named in the prose.
//                         No verified evidence ⇒ not a finding (suppressed as ungrounded/rejected).
//
//   per deduplicated finding (same rubric item × route × implicated controls/text):
//     confidence = mean_i(e_i) × agreement
//       agreement = occurrences ÷ screen-states on that route where the item was judged AND the
//                   same evidence (implicated controls / quoted text) was present — an issue
//                   flagged on 1 of 6 states that showed that control is weakly supported.
//
// A product is deliberately conservative: a heuristic that does not apply (applicability ≈ 0),
// an unconfirmed violation, or a one-off among many observations cannot score high.

/** Grounding when evidence was cited and verified but the observation names none of it. */
export const GROUNDING_UNNAMED = 0.6;

/**
 * Default `minConfidence` cutoff for reported findings. Findings below it are counted and
 * summarized in `report.suppressed`, never silently dropped.
 *
 * 0.75 is the calibration study's recommendation (simuli-jevdog
 * `docs/dogfooding/jevitate/2026-09-23-ux-dogfood.md`, "Confidence calibration" → Recommendation),
 * measured on the PRE-fix confidence (inverted noul-false, no applicability gate).
 * TODO(calibration): re-derive this from a re-run of that study on the corrected confidence
 * (confidence.ts formula) — the owner sets the final value from that data.
 */
export const DEFAULT_MIN_CONFIDENCE = 0.75;

/**
 * Env var that overrides the config file and `DEFAULT_MIN_CONFIDENCE` (a CLI `--min-confidence`
 * flag overrides all). The config-file key is `ux.minConfidence` in `~/.jevitate/config.json`.
 */
export const MIN_CONFIDENCE_ENV = "JEVITATE_UX_MIN_CONFIDENCE";

export class MinConfidenceError extends Error {
  readonly code = "E_UX_MIN_CONFIDENCE" as const;
  constructor(value: string, source: string) {
    super(`${source} must be a number in [0,1], got '${value}'`);
    this.name = "MinConfidenceError";
  }
}

function parseCutoff(raw: string, source: string): number {
  const n = Number(raw);
  if (raw.trim().length === 0 || !Number.isFinite(n) || n < 0 || n > 1) throw new MinConfidenceError(raw, source);
  return n;
}

/**
 * Precedence: explicit flag > `JEVITATE_UX_MIN_CONFIDENCE` > config `ux.minConfidence` >
 * `DEFAULT_MIN_CONFIDENCE`. Invalid values throw — never silently replaced by the default.
 */
export function resolveMinConfidence(
  flag: string | number | undefined,
  env: Readonly<Record<string, string | undefined>>,
  configValue?: number,
): number {
  if (flag !== undefined) return parseCutoff(String(flag), "--min-confidence");
  const fromEnv = env[MIN_CONFIDENCE_ENV];
  if (fromEnv !== undefined) return parseCutoff(fromEnv, MIN_CONFIDENCE_ENV);
  if (configValue !== undefined) return parseCutoff(String(configValue), "config ux.minConfidence");
  return DEFAULT_MIN_CONFIDENCE;
}

export function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

/** Rounds to 2 decimals for a stable, readable report. */
export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export interface OccurrenceEvidence {
  readonly violation: number;
  readonly applicability: number;
  readonly grounding: number;
}

/** confidence = mean(violation × applicability × grounding) × (occurrences ÷ judged). */
export function combineConfidence(
  occurrences: readonly OccurrenceEvidence[],
  judgedOnRoute: number,
): { confidence: number; basis: { violation: number; applicability: number; grounding: number; agreement: number } } {
  const k = occurrences.length;
  if (k === 0) return { confidence: 0, basis: { violation: 0, applicability: 0, grounding: 0, agreement: 0 } };
  const mean = (f: (o: OccurrenceEvidence) => number) => occurrences.reduce((a, o) => a + f(o), 0) / k;
  const perOccurrence = mean((o) => clamp01(o.violation) * clamp01(o.applicability) * clamp01(o.grounding));
  const agreement = clamp01(k / Math.max(k, judgedOnRoute));
  return {
    confidence: round2(perOccurrence * agreement),
    basis: {
      violation: round2(mean((o) => o.violation)),
      applicability: round2(mean((o) => o.applicability)),
      grounding: round2(mean((o) => o.grounding)),
      agreement: round2(agreement),
    },
  };
}
