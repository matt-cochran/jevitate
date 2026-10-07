/**
 * The values a page reveals in secret fields (password inputs, secret-marked elements: learned in
 * memory only, never stored) and the page facts read beside them — shared by the action delta
 * (#303) and the goal loop's new-text line (#390). Not part of the package API.
 */

import type { Page } from "playwright";
import { REVEALED_SECRET_SELECTORS, redactCredentialShapes, redactText } from "@jevitate/ai-core";
import { clockBounded } from "./clock-bound.js";

/** BROWSER CODE — values the page shows in secret fields (learned, in memory only) + page facts. */
export function pageFacts(selectors: readonly string[]): { learned: string[]; title: string; canvas: boolean } {
  const learned: string[] = [];
  const take = (v: string | null | undefined): void => {
    const t = (v ?? "").trim();
    if (t !== "" && t.length <= 2_000) learned.push(t);
  };
  for (const el of Array.from(document.querySelectorAll('input[type="password"]'))) take((el as HTMLInputElement).value);
  for (const sel of selectors) {
    let found: Element[] = [];
    try {
      found = Array.from(document.querySelectorAll(sel));
    } catch {
      continue;
    }
    for (const el of found) {
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
        take(el.value);
        continue;
      }
      // A marked element's text: the whole text when it is one word, else its credential-like
      // words (12+ chars, no space) — never a label word, which would then be masked everywhere.
      const text = (el.textContent ?? "").trim();
      if (text !== "" && !/\s/.test(text) && text.length >= 6) take(text);
      else for (const w of text.split(/\s+/)) if (w.length >= 12) take(w);
    }
  }
  const vw = window.innerWidth * window.innerHeight;
  let canvas = false;
  for (const c of Array.from(document.querySelectorAll("canvas"))) {
    const r = c.getBoundingClientRect();
    if (vw > 0 && r.width * r.height >= vw * 0.5) canvas = true;
  }
  return { learned, title: document.title, canvas };
}

/** How long reading the revealed values may take (ms) before the text is redacted without them. */
const REVEALED_READ_MS = 1_500;

/**
 * #390: page text redacted as a delta's is — registered secrets, the values the page shows in
 * password / secret-marked fields (read now, memory only) and every credential shape.
 */
export async function redactRevealed(page: Page, text: string, secrets: readonly string[]): Promise<string> {
  const facts = await clockBounded(
    page.evaluate(pageFacts, REVEALED_SECRET_SELECTORS).catch(() => null),
    REVEALED_READ_MS,
    null,
  );
  const learned = (facts?.learned ?? []).filter((v) => v.length >= 4);
  return redactCredentialShapes(redactText(text, [...secrets, ...learned]));
}
