import type { Recording, PageSegment } from "./schema.js";
import { RecordingSchema } from "./schema.js";

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

  newPages.push(...segment.pages);

  if (mode === "insert") {
    if (afterSteps.length > 0) {
      newPages.push({ ...targetPage, steps: afterSteps });
    }
    newPages.push(...base.pages.slice(at.page + 1));
  }
  // "replace-from": afterSteps and every following base page are dropped.

  const result: Recording = {
    ...base,
    pages: mergeAdjacentSameUrlPages(newPages),
  };

  const validation = RecordingSchema.safeParse(result);
  if (!validation.success) {
    throw new Error(`Recording validation failed: ${validation.error.message}`);
  }
  return validation.data;
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
