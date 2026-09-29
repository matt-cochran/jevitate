/**
 * Pure geometry over rendered boxes (#148) — no browser, no I/O, so every visual-state check that
 * reasons about position or size (in-viewport, size bounds, overlap) shares one definition, and
 * other signals (e.g. a viewport/overflow check) can reuse it. Boxes are CSS pixels in viewport
 * coordinates, as `getBoundingClientRect` reports them.
 */

export interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** The area two boxes share (0 when they do not intersect). */
export function intersectionArea(a: Box, b: Box): number {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

/**
 * The fraction (0..1) of `box` that lies inside `viewport` — the same number an
 * `IntersectionObserver` reports as `intersectionRatio`. A box with no area is 0 (nothing of it can
 * be seen), never a division by zero.
 */
export function intersectionRatio(box: Box, viewport: Box): number {
  const area = box.width * box.height;
  if (!(area > 0)) return 0;
  return Math.min(1, intersectionArea(box, viewport) / area);
}

/** True when the two boxes share a positive area (touching edges do not overlap). */
export function boxesOverlap(a: Box, b: Box): boolean {
  return intersectionArea(a, b) > 0;
}

export interface SizeBounds {
  readonly minWidth?: number | undefined;
  readonly maxWidth?: number | undefined;
  readonly minHeight?: number | undefined;
  readonly maxHeight?: number | undefined;
}

/** The first bound `box` violates (`"width 12 < minWidth 20"`), or null when it fits every one. */
export function sizeViolation(box: Box, bounds: SizeBounds): string | null {
  const w = round(box.width);
  const h = round(box.height);
  if (bounds.minWidth !== undefined && box.width < bounds.minWidth) return `width ${w} < minWidth ${bounds.minWidth}`;
  if (bounds.maxWidth !== undefined && box.width > bounds.maxWidth) return `width ${w} > maxWidth ${bounds.maxWidth}`;
  if (bounds.minHeight !== undefined && box.height < bounds.minHeight) return `height ${h} < minHeight ${bounds.minHeight}`;
  if (bounds.maxHeight !== undefined && box.height > bounds.maxHeight) return `height ${h} > maxHeight ${bounds.maxHeight}`;
  return null;
}

/** A number rounded for evidence text (2 decimals, no trailing zeros). */
export function round(n: number): number {
  return Math.round(n * 100) / 100;
}
