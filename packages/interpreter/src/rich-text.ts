import type { Locator, Page } from "playwright";
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

type Placement = { readonly ok: true; readonly text: string } | { readonly ok: false; readonly reason: string };

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
  return { ok: true, text: text.slice(start, end) };
}

/**
 * Performs `edit` inside the contenteditable `locator` resolves to. Throws (fail-closed) when the
 * target is not a contenteditable or the anchor cannot be placed; the page is untouched then.
 */
export async function applyTextEdit(page: Page, locator: Locator, edit: TextEdit): Promise<void> {
  const caret: "start" | "end" | null = edit.action === "insertBefore" ? "start" : edit.action === "insertAfter" ? "end" : null;
  const placed = await locator.evaluate(placeSelection, { anchor: edit.anchor, caret });
  if (!placed.ok) throw new Error(`editText refused: ${placed.reason}`);
  if (edit.action === "format") {
    if (edit.format === undefined) throw new Error("editText refused: format has no `format`");
    await page.keyboard.press(FORMAT_KEYS[edit.format]);
    return;
  }
  const value = edit.value;
  if (value === undefined) throw new Error(`editText refused: ${edit.action} has no value`);
  if (value === "") {
    // A deletion: removes the selected range (an empty insert is a no-op).
    if (edit.action === "replace" && placed.text !== "") await page.keyboard.press("Delete");
    return;
  }
  await page.keyboard.type(value);
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
