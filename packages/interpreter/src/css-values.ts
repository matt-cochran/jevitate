import type { CompareOp, StyleChannel } from "@jevitate/recording";

/**
 * Pure parsing and comparison of COMPUTED CSS values (#148) — the code that decides a `style` check.
 * A computed color is always `rgb(r, g, b)` / `rgba(r, g, b, a)` in Chromium; an expected value may
 * also be written as `#rgb[a]`, `#rrggbb[aa]`, `transparent` or one of a few basic color names.
 */

export interface Rgba {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly a: number;
}

const NAMED: Readonly<Record<string, Rgba>> = {
  transparent: { r: 0, g: 0, b: 0, a: 0 },
  black: { r: 0, g: 0, b: 0, a: 1 },
  white: { r: 255, g: 255, b: 255, a: 1 },
  red: { r: 255, g: 0, b: 0, a: 1 },
  green: { r: 0, g: 128, b: 0, a: 1 },
  blue: { r: 0, g: 0, b: 255, a: 1 },
  yellow: { r: 255, g: 255, b: 0, a: 1 },
};

/** A CSS color as numbers, or null when `raw` is not a color this parser knows. */
export function parseColor(raw: string): Rgba | null {
  const s = raw.trim().toLowerCase();
  const named = NAMED[s];
  if (named !== undefined) return named;
  const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(s);
  if (hex !== null) {
    const h = hex[1] ?? "";
    const full = h.length <= 4 ? [...h].map((c) => c + c).join("") : h;
    const n = (i: number): number => parseInt(full.slice(i, i + 2), 16);
    return { r: n(0), g: n(2), b: n(4), a: full.length === 8 ? round3(n(6) / 255) : 1 };
  }
  const fn = /^rgba?\(\s*([^)]*)\)$/.exec(s);
  if (fn === null) return null;
  // Both `rgb(1, 2, 3, 0.5)` and `rgb(1 2 3 / 50%)`.
  const parts = (fn[1] ?? "").split(/\s*[,/]\s*|\s+/).filter((p) => p !== "");
  if (parts.length !== 3 && parts.length !== 4) return null;
  const channel = (p: string): number | null => {
    const v = p.endsWith("%") ? (Number(p.slice(0, -1)) * 255) / 100 : Number(p);
    return Number.isFinite(v) ? v : null;
  };
  const alpha = (p: string | undefined): number | null => {
    if (p === undefined) return 1;
    const v = p.endsWith("%") ? Number(p.slice(0, -1)) / 100 : Number(p);
    return Number.isFinite(v) ? v : null;
  };
  const [r, g, b, a] = [channel(parts[0] ?? ""), channel(parts[1] ?? ""), channel(parts[2] ?? ""), alpha(parts[3])];
  if (r === null || g === null || b === null || a === null) return null;
  return { r, g, b, a: round3(a) };
}

/** The leading CSS length/number of `raw` in px (`"12.5px"` → 12.5, `"0.4"` → 0.4), or null. */
export function parseNumber(raw: string): number | null {
  const m = /^\s*(-?\d*\.?\d+(?:e-?\d+)?)(px)?\s*$/i.exec(raw);
  if (m === null) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

/** One numeric channel of a computed value, or null when the value has no such channel. */
export function styleChannel(raw: string, channel: StyleChannel): number | null {
  if (channel === "px") return parseNumber(raw);
  const c = parseColor(raw);
  if (c === null) return null;
  return channel === "alpha" ? c.a : c[channel];
}

/** The outcome of comparing one computed value: held, did not hold, or unreadable (never "held"). */
export type Comparison = { readonly held: boolean; readonly observed: string } | { readonly unreadable: string };

function sameColor(a: Rgba, b: Rgba): boolean {
  const near = (x: number, y: number, eps: number): boolean => Math.abs(x - y) <= eps;
  return near(a.r, b.r, 0.5) && near(a.g, b.g, 0.5) && near(a.b, b.b, 0.5) && near(a.a, b.a, 0.005);
}

function ordered(op: CompareOp, x: number, y: number): boolean {
  switch (op) {
    case "=":
      return x === y;
    case "!=":
      return x !== y;
    case ">":
      return x > y;
    case ">=":
      return x >= y;
    case "<":
      return x < y;
    case "<=":
      return x <= y;
  }
}

/**
 * Compares one computed value with the expected one. With a `channel`, both sides are numbers
 * (the expected side a plain number). Without one: `=`/`!=` compare colors as colors when both
 * sides parse as colors, numbers as numbers, else normalized strings (case/whitespace); `<`/`>`
 * need numbers on both sides. A value that cannot be read as asked is `unreadable`.
 */
export function compareStyle(raw: string, channel: StyleChannel | undefined, op: CompareOp, expected: string): Comparison {
  if (channel !== undefined) {
    const x = styleChannel(raw, channel);
    const y = parseNumber(expected);
    if (x === null) return { unreadable: `${JSON.stringify(raw)} has no ${channel} channel` };
    if (y === null) return { unreadable: `expected ${JSON.stringify(expected)} is not a number` };
    return { held: ordered(op, x, y), observed: String(round3(x)) };
  }
  const xc = parseColor(raw);
  const yc = parseColor(expected);
  if ((op === "=" || op === "!=") && xc !== null && yc !== null) {
    const same = sameColor(xc, yc);
    return { held: op === "=" ? same : !same, observed: raw };
  }
  const xn = parseNumber(raw);
  const yn = parseNumber(expected);
  if (xn !== null && yn !== null) return { held: ordered(op, xn, yn), observed: raw };
  if (op === "=" || op === "!=") {
    const norm = (s: string): string => s.trim().replace(/\s+/g, " ").toLowerCase();
    const same = norm(raw) === norm(expected);
    return { held: op === "=" ? same : !same, observed: raw };
  }
  return { unreadable: `${JSON.stringify(raw)} ${op} ${JSON.stringify(expected)} needs numbers on both sides` };
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
