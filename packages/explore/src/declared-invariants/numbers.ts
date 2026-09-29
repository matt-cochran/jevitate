/** A Unicode minus (U+2212) or a dash (U+2012–U+2015), normalized to ASCII `-` when read as a sign. */
const MINUS_LIKE_RE = /[−‒–—―]/g;
/**
 * A number token: an optional leading sign (ASCII `-` or a Unicode minus/dash) followed by digits
 * (with `,` thousands separators) and an optional decimal. The sign is consumed only when it is
 * `(?<!\d)` — NOT glued to a preceding digit — and `(?=\d)` — glued to the FOLLOWING digit, no space.
 * That keeps a range's dash a separator, never a sign: `"30–90"` (dash touches the `0` before it) and
 * `"3 – 7"` (a space before the `7`) both read as two plain numbers, while `"−40"` (dash at the very
 * start, glued to the `4`) reads as one negative number (#156).
 */
const NUMBER_TOKEN_RE = /(?:(?<!\d)[−‒–—―-](?=\d))?\d[\d,]*(?:\.\d+)?/g;

/**
 * Every number in a text, left to right (`"≈ 30–90 credits"` → `[30, 90]`; `"−40 credits"` → `[-40]`;
 * `"1,234.5"` → `[1234.5]`) — #156's parser behind `DomObservable.number`.
 */
export function parseNumbers(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(NUMBER_TOKEN_RE)) {
    const n = Number(m[0].replace(MINUS_LIKE_RE, "-").replace(/,/g, ""));
    if (Number.isFinite(n)) out.push(n);
  }
  return out;
}

/** The first number in a text (`number: true`); null when there is none. */
export function parseFirstNumber(text: string): number | null {
  return parseNumbers(text)[0] ?? null;
}
