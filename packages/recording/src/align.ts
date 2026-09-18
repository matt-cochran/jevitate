import type { Recording, RecordedStep } from "./schema.js";
import { stepSignature } from "./signature.js";

/**
 * One "column" of a multi-take alignment: the same semantic step (per
 * `stepSignature`) across N takes. `cells[k]` is the take-`k` step at this
 * aligned position, or `null` when take `k` has no step here (a gap).
 *
 * Invariant (load-bearing for Task 6's column classification): every
 * non-null cell in a column either (a) all share the identical
 * `stepSignature(...)`, or (b) there is exactly one non-null cell (an
 * insertion/gap column). Two different-signature steps are NEVER placed in
 * the same column — see `alignTraces` for how this is enforced structurally.
 */
export interface AlignedColumn {
  cells: (RecordedStep | null)[];
}

/**
 * A step flattened out of its `PageSegment`, paired with that page's `url`
 * — `stepSignature` needs both the step and the page it occurred on, and
 * once flattened a step no longer carries its originating page.
 */
interface FlatStep {
  recordedStep: RecordedStep;
  pageUrl: string;
}

const MATCH_SCORE = 1;
const GAP_PENALTY = -1;
// A same-column pairing of unequal signatures must never win over the
// gap alternative (one deletion + one insertion). -Infinity guarantees
// this in the DP recurrence: it can never beat a finite gap-path score,
// so the optimizer only ever takes the diagonal when the signatures are
// truly equal (see the explicit equality guard in the traceback below).
const MISMATCH_SCORE = Number.NEGATIVE_INFINITY;

/**
 * Aligns N recorded takes of "the same" browser flow into a sequence of
 * `AlignedColumn`s: each column is one semantic step, present (non-null)
 * in whichever takes actually performed it, `null` in takes that didn't.
 *
 * Two takes (N=2): classic Needleman–Wunsch global alignment over each
 * take's `stepSignature` sequence, with mismatches forbidden (see
 * `MISMATCH_SCORE`) — so it behaves as LCS-of-signatures with affine gap
 * cost -1 per gap position and +1 per match, rather than general
 * edit-distance-with-substitution. That's intentional: a "column" only
 * ever means "structurally the same step" (identical `stepSignature`),
 * never "the closest-looking different step".
 *
 * Three or more takes: progressive MSA. Takes 0 and 1 are pairwise-aligned
 * first to seed a "profile" (the growing `AlignedColumn[]`, one signature
 * per column — taken from any one of that column's non-null cells, which
 * by the invariant above are all identical when there's more than one).
 * Each further take is then pairwise-aligned (same restricted-NW
 * algorithm) against the profile's signature sequence, and the result is
 * merged back in: a profile-column match/gap extends that column with the
 * new take's cell (or `null`); a profile insertion (a step in the new
 * take with no match anywhere in the existing profile) becomes a brand
 * new column, `null` for every earlier take.
 *
 * Pure and deterministic: no I/O, no randomness, no reliance on anything
 * but the input `Recording[]` and their content — same inputs always
 * produce byte-identical output.
 */
export function alignTraces(takes: Recording[]): AlignedColumn[] {
  if (takes.length === 0) return [];

  const flatTakes = takes.map(flattenTake);
  const sigTakes = flatTakes.map((flat) =>
    flat.map((fs) => stepSignature(fs.recordedStep.step, fs.pageUrl)),
  );

  if (takes.length === 1) {
    return flatTakes[0].map((fs) => ({ cells: [fs.recordedStep] }));
  }

  // Seed the profile from takes 0 and 1.
  const seedPairs = needlemanWunsch(sigTakes[0], sigTakes[1]);
  let columns: (RecordedStep | null)[][] = seedPairs.map(([i, j]) => {
    const cells: (RecordedStep | null)[] = new Array(takes.length).fill(null);
    if (i !== null) cells[0] = flatTakes[0][i].recordedStep;
    if (j !== null) cells[1] = flatTakes[1][j].recordedStep;
    return cells;
  });
  let columnSignatures: string[] = seedPairs.map(([i, j]) => {
    // By construction at least one of i/j is non-null for every pair.
    return i !== null ? sigTakes[0][i] : sigTakes[1][j as number];
  });

  // Fold in each further take, one at a time, against the growing profile.
  for (let t = 2; t < takes.length; t++) {
    const sigT = sigTakes[t];
    const pairs = needlemanWunsch(sigT, columnSignatures);

    const newColumns: (RecordedStep | null)[][] = [];
    const newColumnSignatures: string[] = [];

    for (const [takeIdx, profileIdx] of pairs) {
      if (profileIdx !== null) {
        // Existing profile column: carry its prior cells forward, and
        // fill in take t's cell (or leave it null, if this is a gap for
        // take t at this profile position).
        const col = columns[profileIdx].slice();
        if (takeIdx !== null) col[t] = flatTakes[t][takeIdx].recordedStep;
        newColumns.push(col);
        newColumnSignatures.push(columnSignatures[profileIdx]);
      } else {
        // No match anywhere in the existing profile: a brand-new column,
        // null for every earlier take.
        const col: (RecordedStep | null)[] = new Array(takes.length).fill(null);
        col[t] = flatTakes[t][takeIdx as number].recordedStep;
        newColumns.push(col);
        newColumnSignatures.push(sigT[takeIdx as number]);
      }
    }

    columns = newColumns;
    columnSignatures = newColumnSignatures;
  }

  return columns.map((cells) => ({ cells }));
}

function flattenTake(rec: Recording): FlatStep[] {
  return rec.pages.flatMap((page) =>
    page.steps.map((recordedStep) => ({ recordedStep, pageUrl: page.url })),
  );
}

/**
 * One step of a Needleman–Wunsch traceback: `[aIndex, bIndex]`, each
 * either the 0-based index into the corresponding input sequence or
 * `null` when that sequence has a gap at this position. Exactly one of
 * the two is `null` on a gap step; both are non-null on a match (which,
 * per the restricted scoring below, only ever happens when `a[aIndex]
 * === b[bIndex]`).
 */
type AlignmentPair = [number | null, number | null];

/**
 * Restricted Needleman–Wunsch global alignment of two signature
 * sequences: match = +1 (only for equal signatures), gap = -1 per
 * position, and same-column pairing of unequal signatures is forbidden
 * (`MISMATCH_SCORE = -Infinity`) so the optimum never chooses it over a
 * pair of gaps. Returns the ordered list of `AlignmentPair`s from the
 * start of both sequences to their end.
 *
 * Deterministic tie-breaking: when a DP cell's optimal score is reachable
 * by more than one predecessor (a genuine tie), the traceback prefers, in
 * order: diagonal (match) > left (gap in `a`, i.e. `b`'s element is
 * unmatched) > up (gap in `b`, i.e. `a`'s element is unmatched). Walking
 * the traceback backward, taking "left" before "up" at a tie means the
 * earlier-emitted (i.e. later-in-sequence, since traceback runs end to
 * start) gap column is `b`'s leftover element — so forward, in sequence
 * order, `a`'s leftover element surfaces in its own column BEFORE `b`'s
 * leftover element does, which keeps each sequence's steps in their own
 * original relative order rather than letting the two sequences'
 * trailing unmatched runs interleave arbitrarily. This is applied
 * consistently and requires no randomness or ordering beyond the indices
 * themselves, so identical inputs always retrace the same path.
 */
function needlemanWunsch(a: string[], b: string[]): AlignmentPair[] {
  const n = a.length;
  const m = b.length;

  // score[i][j] = best alignment score of a[0..i) against b[0..j).
  const score: number[][] = Array.from({ length: n + 1 }, () =>
    new Array(m + 1).fill(0),
  );
  for (let i = 1; i <= n; i++) score[i][0] = score[i - 1][0] + GAP_PENALTY;
  for (let j = 1; j <= m; j++) score[0][j] = score[0][j - 1] + GAP_PENALTY;

  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const matchScore = a[i - 1] === b[j - 1] ? MATCH_SCORE : MISMATCH_SCORE;
      const diag = score[i - 1][j - 1] + matchScore;
      const up = score[i - 1][j] + GAP_PENALTY; // a[i-1] unmatched
      const left = score[i][j - 1] + GAP_PENALTY; // b[j-1] unmatched
      score[i][j] = Math.max(diag, up, left);
    }
  }

  const pairs: AlignmentPair[] = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1] && score[i][j] === score[i - 1][j - 1] + MATCH_SCORE) {
      pairs.push([i - 1, j - 1]);
      i--;
      j--;
      continue;
    }
    if (j > 0 && score[i][j] === score[i][j - 1] + GAP_PENALTY) {
      pairs.push([null, j - 1]);
      j--;
      continue;
    }
    if (i > 0 && score[i][j] === score[i - 1][j] + GAP_PENALTY) {
      pairs.push([i - 1, null]);
      i--;
      continue;
    }
    // Unreachable: (i,j) is always reachable from at least one of the
    // three predecessors it was computed from above.
    throw new Error(`alignTraces: traceback failed at (${i}, ${j})`);
  }

  pairs.reverse();
  return pairs;
}
