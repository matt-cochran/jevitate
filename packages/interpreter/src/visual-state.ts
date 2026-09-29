import type { Locator } from "playwright";
import type { Assertion, TargetDescriptor } from "@jevitate/recording";
import { compareStyle, type Comparison } from "./css-values.js";
import { boxesOverlap, intersectionRatio, round, sizeViolation, type Box } from "./geometry.js";
import { readFlashes } from "./flash-recorder.js";

/**
 * Visual-state assertions (#148): computed style, geometry (in-viewport, size, overlap), attribute
 * state and transient flashes — each READ by a fixed built-in page function and DECIDED here, by
 * code, never by a model and never by evaluating a declared string. A missing target or an
 * unreadable value never holds; the verdict always carries what was observed (evidence).
 */

export type VisualAssertion = Extract<Assertion, { kind: "style" | "inViewport" | "box" | "overlap" | "attr" | "flashed" }>;

const VISUAL_KINDS: ReadonlySet<string> = new Set(["style", "inViewport", "box", "overlap", "attr", "flashed"]);

export function isVisualAssertion(a: Assertion): a is VisualAssertion {
  return VISUAL_KINDS.has(a.kind);
}

/** One verdict with the evidence that decided it. */
export interface VisualVerdict {
  readonly held: boolean;
  readonly detail: string;
}

/** Default minimum visible fraction for `inViewport`. */
export const DEFAULT_IN_VIEWPORT_MIN = 0.5;

/** Bound on elements a visual check reads (a selector matching thousands is summarized, not all read). */
const MAX_ELEMENTS = 200;

/** BROWSER CODE — every matched element's box, plus the viewport box. */
function readBoxes(els: Element[], max: number): { boxes: Box[]; viewport: Box } {
  return {
    boxes: els.slice(0, max).map((e) => {
      const r = e.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    }),
    viewport: { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight },
  };
}

/** BROWSER CODE — one computed style property of every matched element. */
function readStyles(els: Element[], a: { property: string; max: number }): string[] {
  return els.slice(0, a.max).map((e) => window.getComputedStyle(e).getPropertyValue(a.property));
}

/** BROWSER CODE — one attribute of the first matched element (null when absent / no match). */
function readAttr(els: Element[], name: string): { matched: number; value: string | null } {
  const first = els[0];
  return { matched: els.length, value: first === undefined ? null : first.getAttribute(name) };
}

/** Every matched element's box and the viewport — the one geometry read other modules reuse. */
export async function boxesOf(locator: Locator): Promise<{ boxes: Box[]; viewport: Box }> {
  return locator.evaluateAll(readBoxes, MAX_ELEMENTS);
}

/** One computed style property of every matched element (bounded). */
export async function stylesOf(locator: Locator, property: string): Promise<string[]> {
  return locator.evaluateAll(readStyles, { property, max: MAX_ELEMENTS });
}

/** An attribute of the first matched element. */
export async function attrOf(locator: Locator, name: string): Promise<{ matched: number; value: string | null }> {
  return locator.evaluateAll(readAttr, name);
}

function fmtBox(b: Box): string {
  return `${round(b.width)}×${round(b.height)} at (${round(b.x)},${round(b.y)})`;
}

/**
 * Evaluates one visual assertion ONCE (no polling — callers poll). `locate` resolves a descriptor
 * to a Locator (page- or row-rooted). A browser error (a detached element mid-read) is a failed
 * sample with its reason, never a throw.
 */
export async function evaluateVisual(
  a: VisualAssertion,
  locate: (d: TargetDescriptor) => Locator,
): Promise<VisualVerdict> {
  try {
    return await evaluateVisualUnsafe(a, locate);
  } catch (e) {
    return { held: false, detail: `unreadable: ${(e instanceof Error ? e.message : String(e)).split("\n")[0]}` };
  }
}

async function evaluateVisualUnsafe(a: VisualAssertion, locate: (d: TargetDescriptor) => Locator): Promise<VisualVerdict> {
  const target = locate(a.target);
  switch (a.kind) {
    case "style": {
      const values = await stylesOf(target, a.property);
      if (values.length === 0) return { held: false, detail: "unreadable: no element matched" };
      const what = a.channel === undefined ? a.property : `${a.channel}(${a.property})`;
      const results: Comparison[] = values.map((v) => compareStyle(v, a.channel, a.op, a.value));
      const unreadable = results.find((r): r is { unreadable: string } => "unreadable" in r);
      if (unreadable !== undefined) return { held: false, detail: `unreadable: ${what}: ${unreadable.unreadable}` };
      const observed = results.map((r) => ("observed" in r ? r.observed : "?"));
      const failing = results.flatMap((r, i) => ("held" in r && !r.held ? [i] : []));
      const shown = [...new Set(observed)].slice(0, 5).join(", ");
      if (failing.length === 0) return { held: true, detail: `${what} ${a.op} ${a.value} on all ${values.length} element(s) (observed ${shown})` };
      return {
        held: false,
        detail: `${what} ${a.op} ${a.value} failed on ${failing.length} of ${values.length} element(s) (observed ${failing
          .slice(0, 5)
          .map((i) => observed[i])
          .join(", ")})`,
      };
    }
    case "inViewport": {
      const { boxes, viewport } = await boxesOf(target);
      if (boxes.length === 0) return { held: false, detail: "unreadable: no element matched" };
      const min = a.min ?? DEFAULT_IN_VIEWPORT_MIN;
      const ratios = boxes.map((b) => round(intersectionRatio(b, viewport)));
      const worst = Math.min(...ratios);
      const vp = `viewport ${round(viewport.width)}×${round(viewport.height)}`;
      return worst >= min
        ? { held: true, detail: `in viewport: ratio ${ratios.slice(0, 5).join(", ")} >= ${min} (${vp})` }
        : { held: false, detail: `not in viewport: ratio ${ratios.slice(0, 5).join(", ")} < ${min} (${fmtBox(boxes[ratios.indexOf(worst)] ?? boxes[0]!)}, ${vp})` };
    }
    case "box": {
      const { boxes } = await boxesOf(target);
      if (boxes.length === 0) return { held: false, detail: "unreadable: no element matched" };
      for (const b of boxes) {
        const v = sizeViolation(b, a);
        if (v !== null) return { held: false, detail: `${v} (${fmtBox(b)})` };
      }
      return { held: true, detail: `${boxes.length} element(s) within size bounds (${fmtBox(boxes[0]!)})` };
    }
    case "overlap": {
      const [mine, theirs] = await Promise.all([boxesOf(target), boxesOf(locate(a.other))]);
      const x = mine.boxes[0];
      const y = theirs.boxes[0];
      if (x === undefined || y === undefined) return { held: false, detail: `unreadable: ${x === undefined ? "target" : "other"} matched no element` };
      const overlaps = boxesOverlap(x, y);
      const detail = `${overlaps ? "overlap" : "no overlap"}: ${fmtBox(x)} vs ${fmtBox(y)}`;
      return { held: overlaps === a.overlapping, detail };
    }
    case "attr": {
      const { matched, value } = await attrOf(target, a.name);
      if (matched === 0) return { held: false, detail: "unreadable: no element matched" };
      const seen = value === null ? `${a.name} absent` : `${a.name}=${JSON.stringify(value)}`;
      if (a.absent === true) return { held: value === null, detail: seen };
      if (a.value === undefined) return { held: value !== null, detail: seen };
      return { held: value === a.value, detail: seen };
    }
    case "flashed": {
      const kind = a.className !== undefined ? "class" : a.attr !== undefined ? "attr" : "animation";
      const name = a.className ?? a.attr;
      const what = kind === "class" ? `class .${name}` : kind === "attr" ? `attribute ${name}` : "an animation";
      const r = await readFlashes(target, { kind, name, withinMs: a.withinMs });
      if (r.matched === 0) return { held: false, detail: "unreadable: no element matched" };
      if (!r.installed) return { held: false, detail: "unreadable: the flash recorder was not installed before the action" };
      const after = r.sawInput ? "after the last input" : "since the recorder was installed";
      if (r.delayMs !== null) return { held: true, detail: `gained ${what} ${r.delayMs}ms ${after}` };
      const late = r.late > 0 ? `; ${r.late} gain(s) came later than ${a.withinMs}ms` : "";
      return { held: false, detail: `never gained ${what} ${after} on ${r.matched} element(s) (${r.recorded} change(s) recorded${late})` };
    }
  }
}
