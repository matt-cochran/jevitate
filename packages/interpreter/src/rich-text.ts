import type { ElementHandle, Locator, Page } from "playwright";
import type { TextAnchor, TextEdit, TextFormat } from "@jevitate/recording";

/**
 * Rich-text editing INSIDE a `contenteditable` (#148) — one implementation shared by the explore op
 * and Recording replay, so a recorded edit replays exactly as it was performed.
 *
 * The anchor is resolved against the element's text by a fixed page function: its text nodes are
 * concatenated with whitespace runs collapsed to one space (so source indentation never breaks a
 * quote), the anchor is located in that text, and a DOM Range is placed over it (or a caret at its
 * start/end). The text is then TYPED with keyboard events — never `fill`, which would replace the
 * whole element — and formatting is applied with the platform's shortcut. A quote that is not in the
 * element, or occurs more than once with no `occurrence`, FAILS CLOSED (throws); it never degrades to
 * replacing the whole element.
 */

/** The shortcut that toggles each format in a contenteditable. */
const FORMAT_KEYS: Readonly<Record<TextFormat, string>> = {
  bold: "ControlOrMeta+b",
  italic: "ControlOrMeta+i",
  underline: "ControlOrMeta+u",
};

type Placement =
  | { readonly ok: true; readonly text: string; readonly full: string; readonly start: number; readonly end: number; readonly html: string }
  | { readonly ok: false; readonly reason: string };

/**
 * F4: an edit that did not land — the editor rejected the input, or the anchor sat in a part of the
 * element that is not editable — fails typed instead of reporting ok. The message never carries a value.
 */
export class TextEditNotAppliedError extends Error {
  readonly code = "E_EDIT_NOT_APPLIED";
  constructor(detail: string) {
    super(`E_EDIT_NOT_APPLIED: editText ${detail}; the target's text read back afterwards does not hold the edit (the editor rejected the input, or the anchor is not editable)`);
    this.name = "TextEditNotAppliedError";
  }
}

/**
 * BROWSER CODE — places the selection for `anchor` inside `el` (collapsed to its start/end when
 * `caret` says so). No imports, no closure over module scope.
 */
function placeSelection(
  el: Element,
  arg: { anchor: TextAnchor; caret: "start" | "end" | null },
): Placement {
  const host = el as HTMLElement;
  if (!host.isContentEditable) return { ok: false, reason: "target is not a contenteditable" };
  // The element's text with whitespace runs collapsed, and for every character the text node and
  // offset it came from.
  const map: Array<{ node: Text; offset: number }> = [];
  let text = "";
  const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n !== null; n = walker.nextNode()) {
    const node = n as Text;
    const data = node.data;
    for (let i = 0; i < data.length; i++) {
      const ch = data[i] ?? "";
      if (/\s/.test(ch)) {
        if (text === "" || text.endsWith(" ")) continue;
        text += " ";
      } else {
        text += ch;
      }
      map.push({ node, offset: i });
    }
  }
  const norm = (s: string): string => s.replace(/\s+/g, " ");
  let start: number;
  let end: number;
  const anchor = arg.anchor;
  if ("quote" in anchor) {
    const q = norm(anchor.quote);
    if (q.trim() === "") return { ok: false, reason: "empty quote" };
    const hits: number[] = [];
    for (let i = text.indexOf(q); i !== -1; i = text.indexOf(q, i + 1)) hits.push(i);
    if (hits.length === 0) return { ok: false, reason: `quote ${JSON.stringify(anchor.quote)} is not in the target's text` };
    if (anchor.occurrence === undefined && hits.length > 1) {
      return { ok: false, reason: `quote ${JSON.stringify(anchor.quote)} occurs ${hits.length} times in the target's text (ambiguous)` };
    }
    const at = hits[anchor.occurrence ?? 0];
    if (at === undefined) return { ok: false, reason: `quote occurs ${hits.length} time(s), no occurrence ${anchor.occurrence}` };
    start = at;
    end = at + q.length;
  } else if ("start" in anchor) {
    if (anchor.end > text.length) return { ok: false, reason: `offsets ${anchor.start}..${anchor.end} exceed the text length ${text.length}` };
    start = anchor.start;
    end = anchor.end;
  } else {
    start = anchor.at === "start" ? 0 : text.length;
    end = start;
  }
  if (arg.caret === "start") end = start;
  if (arg.caret === "end") start = end;
  const range = document.createRange();
  const pos = (i: number, isEnd: boolean): { node: Node; offset: number } => {
    if (map.length === 0) return { node: host, offset: isEnd ? host.childNodes.length : 0 };
    // An end position sits just AFTER the previous character (so a range never swallows the
    // whitespace that follows it); a start sits AT its character.
    if (isEnd && i > 0) {
      const prev = map[i - 1]!;
      return { node: prev.node, offset: prev.offset + 1 };
    }
    const at = map[i];
    if (at !== undefined) return { node: at.node, offset: at.offset };
    const last = map[map.length - 1]!;
    return { node: last.node, offset: last.offset + 1 };
  };
  const s = pos(start, false);
  const e = start === end ? s : pos(end, true);
  host.focus();
  range.setStart(s.node, s.offset);
  range.setEnd(e.node, e.offset);
  const selection = window.getSelection();
  if (selection === null) return { ok: false, reason: "no selection API" };
  selection.removeAllRanges();
  selection.addRange(range);
  return { ok: true, text: text.slice(start, end), full: text, start, end, html: host.innerHTML };
}

/**
 * BROWSER CODE — the element's text, collapsed exactly as `placeSelection` collapses it, and its markup.
 * No imports, no closure over module scope.
 */
function readEdited(el: Element): { text: string; html: string } {
  let text = "";
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n !== null; n = walker.nextNode()) {
    const data = (n as Text).data;
    for (let i = 0; i < data.length; i++) {
      const ch = data[i] ?? "";
      if (/\s/.test(ch)) {
        if (text === "" || text.endsWith(" ")) continue;
        text += " ";
      } else {
        text += ch;
      }
    }
  }
  return { text, html: (el as HTMLElement).innerHTML };
}

const collapse = (s: string): string => s.replace(/\s+/g, " ");

function occurrences(haystack: string, needle: string): number {
  let n = 0;
  for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + 1)) n++;
  return n;
}

/**
 * Whether the text read back holds the edit (F4). `before` is the element's collapsed text when the
 * selection was placed, `[start, end)` the selected range in it. A change that should alter the text
 * must alter it, and the inserted text must occur in the result at least as often as it would after
 * the edit (a count, so text already in the element is no proof). Exported for the unit test.
 */
export function editLanded(before: string, start: number, end: number, value: string, after: string): boolean {
  const expected = collapse(before.slice(0, start) + value + before.slice(end));
  if (expected !== before && after === before) return false;
  const needle = collapse(value).trim();
  if (needle === "") return true;
  return occurrences(after, needle) >= occurrences(expected, needle);
}

/** Reads the edit back a few times (each a round trip, so an editor that applies input in a microtask has applied it). */
async function readBack(handle: ElementHandle | null, locator: Locator | null, accept: (r: { text: string; html: string }) => boolean): Promise<boolean | "unreadable"> {
  for (let attempt = 0; attempt < 5; attempt++) {
    let read: { text: string; html: string } | null = null;
    // The element edited (a target found by its text no longer matches once its text changed); a
    // framework that replaced the element is read through the locator instead, when one is allowed.
    if (handle !== null) read = await handle.evaluate(readEdited).catch(() => null);
    if (read === null && locator !== null) read = await locator.evaluate(readEdited, undefined, { timeout: 2_000 }).catch(() => null);
    if (read === null) return "unreadable";
    if (accept(read)) return true;
  }
  return false;
}

/**
 * Performs `edit` inside the contenteditable `locator` resolves to. Throws (fail-closed) when the
 * target is not a contenteditable or the anchor cannot be placed; the page is untouched then.
 */
export async function applyTextEdit(page: Page, locator: Locator, edit: TextEdit & { readonly beforeType?: () => void; readonly boundSecret?: boolean }): Promise<void> {
  const caret: "start" | "end" | null = edit.action === "insertBefore" ? "start" : edit.action === "insertAfter" ? "end" : null;
  // A bound secret stays on this element's document: a handle dies with it, where a locator would find the next page's.
  const bound: ElementHandle | null = edit.boundSecret === true ? await locator.elementHandle() : null;
  const placed = bound !== null ? await bound.evaluate(placeSelection, { anchor: edit.anchor, caret }) : await locator.evaluate(placeSelection, { anchor: edit.anchor, caret });
  if (!placed.ok) throw new Error(`editText refused: ${placed.reason}`);
  // F4: every path reads the element back — through the same handle for a bound secret — and fails
  // typed when the change did not land, rather than reporting ok with nothing typed.
  // A bound secret is read back on its own document only (never through a locator that could find the next page's).
  const handle = bound ?? (await locator.elementHandle({ timeout: 2_000 }).catch(() => null));
  const verify = async (detail: string, accept: (r: { text: string; html: string }) => boolean): Promise<void> => {
    const landed = await readBack(handle, bound !== null ? null : locator, accept);
    if (landed === "unreadable") throw new TextEditNotAppliedError(`${detail} could not be read back`);
    if (!landed) throw new TextEditNotAppliedError(detail);
  };
  if (edit.action === "format") {
    if (edit.format === undefined) throw new Error("editText refused: format has no `format`");
    await page.keyboard.press(FORMAT_KEYS[edit.format]);
    // Formatting changes markup, not text: a format that changed nothing did not land.
    if (placed.text !== "") await verify(`format ${edit.format}`, (r) => r.html !== placed.html);
    return;
  }
  const value = edit.value;
  if (value === undefined) throw new Error(`editText refused: ${edit.action} has no value`);
  if (value === "") {
    // A deletion: removes the selected range (an empty insert is a no-op).
    if (edit.action === "replace" && placed.text !== "") {
      await page.keyboard.press("Delete");
      await verify("deletion", (r) => editLanded(placed.full, placed.start, placed.end, "", r.text));
    }
    return;
  }
  const typed = (r: { text: string }): boolean => editLanded(placed.full, placed.start, placed.end, value, r.text);
  edit.beforeType?.();
  if (edit.boundSecret !== true) {
    await page.keyboard.type(value);
    await verify(edit.action, typed);
    return;
  }
  // Real keys, so the app sees real input, one at a time, each only while this element's document is
  // still there, still holds the focus and still passes the origin check. At most a key in flight is lost.
  if (bound === null) throw new Error("editText refused: the field to type a secret parameter into is gone");
  for (const key of value) {
    const here = await bound.evaluate(holdsFocus).catch(() => false);
    edit.beforeType?.();
    if (!here) throw new Error("editText refused: the page left before a secret parameter was all typed; the rest was not");
    await page.keyboard.type(key);
  }
  await verify(edit.action, typed);
}

/** BROWSER CODE — is `el` still in its document, with the focus in it? */
function holdsFocus(el: Element): boolean {
  const root = el.getRootNode() as Document | ShadowRoot;
  const active = root.activeElement;
  return el.isConnected && active !== null && (active === el || el.contains(active));
}

/** A short human description of an edit (transcript/history), without the typed value. */
export function describeTextEdit(edit: Pick<TextEdit, "anchor" | "action" | "format">): string {
  const a = edit.anchor;
  const where = "quote" in a ? JSON.stringify(a.quote) : "start" in a ? `characters ${a.start}..${a.end}` : `the ${a.at}`;
  switch (edit.action) {
    case "replace":
      return `replaced ${where}`;
    case "insertBefore":
      return `inserted text before ${where}`;
    case "insertAfter":
      return `inserted text after ${where}`;
    case "format":
      return `made ${where} ${edit.format ?? "?"}`;
  }
}
