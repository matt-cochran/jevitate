import type { Recording, PageSegment, RecordedStep } from "./schema.js";
import { RecordingSchema, mintStepId } from "./schema.js";

// === Step ids (#467) ===

/** Every `stepId` a recording's steps carry. */
export function stepIdsOf(rec: Recording): Set<string> {
  const ids = new Set<string>();
  for (const p of rec.pages) for (const s of p.steps) if (s.stepId !== undefined) ids.add(s.stepId);
  return ids;
}

/** Deterministic JSON (object keys sorted, undefined dropped). */
function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (v !== null && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

/**
 * A `[0, 1)` generator seeded by the recording's content (FNV-1a → mulberry32): minting the same
 * id-less recording twice gives the same ids, so writing one Journey to two stores (a staging store,
 * then the real one) — or re-writing it — never churns its ids or its content hash.
 */
function seededRandom(rec: Recording): () => number {
  let h = 0x811c9dc5;
  const text = canonicalJson(rec);
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  let a = h;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * #467: `rec` with a new stable id (`mintStepId`) on every step that lacks one, unique within the
 * recording; a step that has one keeps it. Returns `rec` itself (same object) when every step
 * already has an id, so a write of an id-complete recording never changes it. `random` defaults to a
 * generator seeded by `rec`'s content (deterministic). Never removes or renames an id; duplicate ids
 * are left for `RecordingSchema` to refuse.
 */
export function ensureStepIds(rec: Recording, random?: () => number): Recording {
  if (rec.pages.every((p) => p.steps.every((s) => s.stepId !== undefined))) return rec;
  const taken = stepIdsOf(rec);
  const draw = random ?? seededRandom(rec);
  const mint = (s: RecordedStep): RecordedStep => {
    if (s.stepId !== undefined) return s;
    const stepId = mintStepId(taken, draw);
    taken.add(stepId);
    return { ...s, stepId };
  };
  return { ...rec, pages: rec.pages.map((p) => ({ ...p, steps: p.steps.map(mint) })) };
}

/**
 * A checkpoint position within a `Recording`: `pages[page].steps[step]`.
 * `step` is a splice cursor, not necessarily an existing step index — it may
 * equal `pages[page].steps.length` to mean "after the last step of this
 * page" (insert-at-end-of-page, or replace-nothing-in-this-page).
 */
export interface SpliceAt {
  page: number;
  step: number;
}

export type SpliceMode = "insert" | "replace-from";

/**
 * Splices a supplemental `segment` Recording into a `base` Recording at a
 * checkpoint (`at`), re-flowing page segmentation so the result is a
 * schema-valid `Recording`. The mechanism record-a-patch (Task 4) and
 * self-healing use to insert or replace steps.
 *
 * - `"insert"`: `segment`'s pages are spliced in whole, immediately before
 *   `base.pages[at.page].steps[at.step]`. The base page at `at.page` is
 *   split around that position: steps before `at.step` stay in a page
 *   carrying the original url/title, `segment`'s pages follow verbatim,
 *   then a page (same original url/title) carries the base's remaining
 *   steps from `at.step` onward, followed by the rest of `base`'s pages
 *   unchanged.
 *
 * - `"replace-from"`: everything from `at` onward — the rest of
 *   `base.pages[at.page]` and every following page — is dropped, and
 *   `segment`'s pages are appended after what remains of `at.page`.
 *
 * Either split half of `at.page` (the "before" steps, or the "after" steps
 * in `insert` mode) is omitted entirely when it would be empty, so splicing
 * at a page boundary never introduces a spurious empty `PageSegment`.
 *
 * Finally, adjacent `PageSegment`s that share the same `url` and `title`
 * are merged into one (steps concatenated, order preserved). This matters
 * because the "before"/segment/"after" pieces above are often really the
 * same page: a same-URL patch segment inserted mid-page, or an empty
 * `segment.pages` (nothing to insert) would otherwise leave 2-3 adjacent
 * `PageSegment`s with an identical `url` — fabricating navigation events
 * that never happened and that downstream diff/align/self-healing would
 * misread as a real page transition. Only *adjacent* equal-url/title pages
 * are merged (never across a differing-url page in between), so a segment
 * that genuinely navigates to a different URL still becomes its own page.
 *
 * Step ids (#467): every base step that survives keeps its `stepId`. A spliced-in step keeps its
 * own id unless a kept base step already has it; a spliced-in step with no id, or a colliding one,
 * gets a newly minted id unique within the result.
 *
 * Pure: neither `base` nor `segment` is mutated, and the same inputs always
 * produce the same output. Fails closed: the result is validated against
 * `RecordingSchema` before being returned, so a caller can never receive a
 * schema-invalid `Recording` — including when this function is applied
 * again to its own well-formed output (idempotent in shape).
 *
 * @throws if `at.page` or `at.step` is out of range for `base`
 * @throws if the spliced result somehow fails `RecordingSchema` validation
 */
export function spliceRecording(
  base: Recording,
  at: SpliceAt,
  segment: Recording,
  mode: SpliceMode,
): Recording {
  if (at.page < 0 || at.page >= base.pages.length) {
    throw new Error(
      `Page index ${at.page} out of range (0-${base.pages.length - 1})`,
    );
  }

  const targetPage = base.pages[at.page];
  if (at.step < 0 || at.step > targetPage.steps.length) {
    throw new Error(
      `Step index ${at.step} out of range (0-${targetPage.steps.length})`,
    );
  }

  const beforeSteps = targetPage.steps.slice(0, at.step);
  const afterSteps = targetPage.steps.slice(at.step);

  const newPages: PageSegment[] = [...base.pages.slice(0, at.page)];

  if (beforeSteps.length > 0) {
    newPages.push({ ...targetPage, steps: beforeSteps });
  }

  const keptBase: PageSegment[] = [...newPages];
  if (mode === "insert") {
    if (afterSteps.length > 0) keptBase.push({ ...targetPage, steps: afterSteps });
    keptBase.push(...base.pages.slice(at.page + 1));
  }
  // A spliced-in step keeps its id only when no kept base step (nor an earlier spliced-in step) has it.
  const claimed = stepIdsOf({ ...base, pages: keptBase });
  const segmentPages: PageSegment[] = segment.pages.map((p) => ({
    ...p,
    steps: p.steps.map((s) => {
      if (s.stepId === undefined) return s;
      if (claimed.has(s.stepId)) {
        const { stepId: _dropped, ...rest } = s;
        return rest;
      }
      claimed.add(s.stepId);
      return s;
    }),
  }));

  newPages.push(...segmentPages);

  if (mode === "insert") {
    if (afterSteps.length > 0) {
      newPages.push({ ...targetPage, steps: afterSteps });
    }
    newPages.push(...base.pages.slice(at.page + 1));
  }
  // "replace-from": afterSteps and every following base page are dropped.

  const result: Recording = ensureSegmentIds(
    { ...base, pages: mergeAdjacentSameUrlPages(newPages) },
    new Set(segmentPages.flatMap((p) => p.steps)),
  );

  const validation = RecordingSchema.safeParse(result);
  if (!validation.success) {
    throw new Error(`Recording validation failed: ${validation.error.message}`);
  }
  return validation.data;
}

/** `rec` with an id minted for each spliced-in step (by identity in `spliced`) that has none. */
function ensureSegmentIds(rec: Recording, spliced: ReadonlySet<RecordedStep>): Recording {
  const missing = rec.pages.some((p) => p.steps.some((s) => spliced.has(s) && s.stepId === undefined));
  if (!missing) return rec;
  const taken = stepIdsOf(rec);
  const draw = seededRandom(rec);
  return {
    ...rec,
    pages: rec.pages.map((p) => ({
      ...p,
      steps: p.steps.map((s) => {
        if (!spliced.has(s) || s.stepId !== undefined) return s;
        const stepId = mintStepId(taken, draw);
        taken.add(stepId);
        return { ...s, stepId };
      }),
    })),
  };
}

/**
 * Merges consecutive `PageSegment`s that share the same `url` and `title`
 * into one, concatenating their `steps` in order. Only ever merges pages
 * that are directly adjacent in the input array — a different-url page
 * sitting between two same-url pages blocks the merge on both sides, since
 * a genuine navigation away and back is not the same page occurrence.
 */
function mergeAdjacentSameUrlPages(pages: PageSegment[]): PageSegment[] {
  const merged: PageSegment[] = [];

  for (const p of pages) {
    const last = merged[merged.length - 1];
    if (last !== undefined && last.url === p.url && last.title === p.title) {
      merged[merged.length - 1] = { ...last, steps: [...last.steps, ...p.steps] };
    } else {
      merged.push(p);
    }
  }

  return merged;
}
