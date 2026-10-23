/**
 * #370: when is a message-named text field a chat COMPOSER (offered `send`, written by
 * `chat.reply`) rather than a form field (typed, then the form's own buttons)? A label alone is not
 * enough — an answer editor's `<textarea aria-label="Chat answer">` with Save/Publish buttons is a
 * form field. A composer needs conversational evidence on the page: a transcript (`role=log`, a
 * live region holding message items, repeated message bubbles) or a Send-shaped control paired with
 * the field (within `PAIRED_SUBMIT_DISTANCE` in the DOM tree).
 *
 * #638: a Send pairing is not evidence when the field's form names a recipient (a To / Recipient /
 * Contact control): that is a message form addressed to a person, not a chat with the app — its
 * text is a form value, and no reply comes back. A transcript still makes it a composer.
 */

/**
 * A field whose text is a message to someone (a chat/inquiry composer: "Type a reply", "Ask…",
 * "Start a new inquiry"), not a form value ("Rationale", "Your name"). Necessary for `send`, never
 * sufficient: the page must also show conversational evidence (`composerEvidence`).
 */
export const MESSAGE_FIELD = /\b(reply|message|ask|chat|inquiry|prompt|say|talk|conversation)\b/i;

/** Free-text input types a message can be written into (not passwords, numbers, dates, emails…). */
export const MESSAGE_INPUT_TYPES: ReadonlySet<string> = new Set(["", "text", "search"]);

/** Names of controls that submit a composer (a chat Send button, a form's submit). */
export const SUBMIT_NAME = /\b(send|submit|reply|ask|post)\b|[→➤➔↑]|^\s*(go|ok)\s*$/i;

/** A Send-shaped control at most this far from the field (DOM tree edges) is the field's own. */
export const PAIRED_SUBMIT_DISTANCE = 6;

/**
 * #638: names of a control that addresses a message to a person ("To", "Cc", "Recipients",
 * "Contact", "Send to"). Matched against the accessible names of the other fields of the form.
 */
export const RECIPIENT_NAME = /^\s*(to|cc|bcc)\b|\b(recipients?|contacts?|addressee|send to)\b/i;

/**
 * BROWSER CODE — serialized by `handle.evaluate`: no imports, no closure over module scope.
 * True when the page around `node` (a message-named text field) reads as a conversation:
 *  - a rendered transcript: `[role=log]`, a live region (`aria-live` polite/assertive, not a
 *    status/alert line) holding 2+ items, or 2+ sibling elements whose class/data attributes name
 *    them messages / bubbles; or
 *  - a Send-shaped button (`args.submit`, the `SUBMIT_NAME` source) within `args.distance` tree
 *    edges of the field — a chat input paired with its Send control — unless the field and that
 *    button share a container holding a recipient field (`args.recipient`, the `RECIPIENT_NAME`
 *    source; #638).
 * A form field whose only buttons are Save / Publish / Update, on a page with no transcript, is
 * neither.
 */
export function composerEvidence(node: Node, args: { submit: string; distance: number; recipient: string }): boolean {
  const el = node as Element;
  const norm = (s: string | null): string => (s === null ? "" : s.replace(/\s+/g, " ").trim());
  const parentOf = (a: Element): Element | null =>
    a.parentElement ?? (a.parentNode instanceof ShadowRoot ? a.parentNode.host : null);
  const rendered = (a: Element): boolean => a.getClientRects().length > 0 || (a as HTMLElement).offsetParent !== null;
  const roots: ParentNode[] = [document];
  const own = el.getRootNode();
  if (own instanceof ShadowRoot) roots.push(own);
  const all = (sel: string): Element[] => roots.flatMap((r) => Array.from(r.querySelectorAll(sel)));

  // 1. A transcript.
  if (all('[role="log"]').some(rendered)) return true;
  for (const live of all('[aria-live="polite"], [aria-live="assertive"]')) {
    const role = norm(live.getAttribute("role")).toLowerCase();
    if (role === "status" || role === "alert" || role === "timer" || role === "progressbar") continue;
    if (rendered(live) && live.children.length >= 2) return true;
  }
  const MESSAGE_ITEM = /(^|[\s_-])(message|msg|bubble|chat-?message|chat-?bubble)s?($|[\s_-])/i;
  const itemLike = (a: Element): boolean =>
    MESSAGE_ITEM.test(a.getAttribute("class") ?? "") ||
    Array.from(a.attributes).some((at) => at.name.startsWith("data-") && MESSAGE_ITEM.test(`${at.name.slice(5)} ${at.value}`));
  const parents = new Map<Element, number>();
  for (const item of all("[class], [data-role], [data-type], [data-message-id], [data-message-author-role]")) {
    if (item === el || item.contains(el) || !itemLike(item) || item.parentElement === null || !rendered(item)) continue;
    const n = (parents.get(item.parentElement) ?? 0) + 1;
    if (n >= 2) return true;
    parents.set(item.parentElement, n);
  }

  // 2. A Send-shaped control paired with the field, unless their shared container addresses the
  // message to a person (#638).
  const submit = new RegExp(args.submit, "i");
  const recipient = new RegExp(args.recipient, "i");
  const labelOf = (a: Element): string => {
    const aria = norm(a.getAttribute("aria-label"));
    if (aria !== "") return aria;
    const by = norm(a.getAttribute("aria-labelledby"));
    if (by !== "") {
      const text = by
        .split(" ")
        .map((id) => norm(document.getElementById(id)?.textContent ?? null))
        .join(" ")
        .trim();
      if (text !== "") return text;
    }
    const id = a.getAttribute("id");
    if (id !== null && id !== "") {
      const forLabel = Array.from(document.querySelectorAll("label")).find((l) => l.htmlFor === id);
      if (forLabel !== undefined) return norm(forLabel.textContent);
    }
    const wrap = a.closest("label");
    if (wrap !== null) return norm(wrap.textContent);
    return norm(a.getAttribute("placeholder")) || norm(a.getAttribute("name"));
  };
  const addressed = (container: Element): boolean =>
    Array.from(
      container.querySelectorAll('select, input:not([type="hidden"]):not([type="submit"]):not([type="button"]), [role="combobox"], [role="listbox"]'),
    ).some((f) => f !== el && !f.contains(el) && rendered(f) && recipient.test(labelOf(f)));
  const up = (a: Element): Element[] => {
    const out: Element[] = [];
    for (let cur: Element | null = a; cur !== null; cur = parentOf(cur)) out.push(cur);
    return out;
  };
  const fieldPath = up(el);
  for (const b of all('button, [role="button"], input[type="submit"], input[type="button"]')) {
    if (b === el || !rendered(b)) continue;
    const name =
      norm(b.getAttribute("aria-label")) ||
      norm(b.textContent) ||
      norm((b as HTMLInputElement).value ?? null) ||
      norm(b.getAttribute("title"));
    if (!submit.test(name)) continue;
    const bp = up(b);
    for (let i = 0; i < fieldPath.length && i <= args.distance; i++) {
      const j = bp.indexOf(fieldPath[i] as Element);
      if (j >= 0) {
        if (i + j <= args.distance && !addressed(fieldPath[i] as Element)) return true;
        break;
      }
    }
  }
  return false;
}
