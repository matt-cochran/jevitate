/**
 * THE occlusion predicate (owner ruling 5) — the single definition of "is this control covered?"
 * shared by the snapshot filter (a covered control is never offered) and the pre-click `act()`
 * gate (a covered target is refused), so the two can never disagree.
 *
 * A control is COVERED when it is rendered and on screen, and the topmost element at its centre is
 * neither the control itself nor one of its descendants. That deliberately includes the case where
 * the topmost element is an ANCESTOR of the control (e.g. the control has `pointer-events: none`, or
 * is clipped/transformed out from under its own centre): a click at that point lands on the
 * ancestor, not the control — the same hit-target rule Playwright's click applies. A descendant on
 * top (the label `<span>` inside a `<button>`) is the control's own content and never covers it.
 *
 * Unrendered controls are not "covered". An off-screen control cannot be probed where it is
 * (scrolling reaches it), so it is probed where scrolling it into view would bring it, and is covered
 * there only by a FIXED layer (#397: a dialog's backdrop stays over the page however it scrolls).
 *
 * A VISUALLY-HIDDEN input (the sr-only idiom: clipped to ≤1px, `clip`/`clip-path` to nothing, or
 * pulled far off-screen) is never what a user clicks — its visible `<label>` (or `aria-labelledby`
 * element) is (#90). Its own centre is not hit-testable, so probing there lands on whatever happens
 * to be underneath (its label, the page, or NOT the overlay covering the label). For such an input
 * the probe runs at its label's centre instead; the label, anything inside it, or the input itself
 * on top is the control's own surface, anything else covers it.
 *
 * OPEN shadow roots (#357) are seen through: the hit-test drills into each open root under the point
 * to the real topmost element, and "own content" is judged across shadow boundaries — so a control
 * inside a web component is probed like a light-DOM one, and a cover inside a component is named
 * from inside it. A CLOSED root is opaque: its host is the hit.
 *
 * BROWSER CODE — serialized by `evaluate`: no imports, no closure over module scope.
 * Returns a description of the covering element (`[data-testid=…]` of its nearest test id, else
 * `<tag#id>`), or null when the control is not covered.
 */
export function occluderOf(node: Node): string | null {
  const el = node as Element;
  const describe = (top: Element): string => {
    const id = top.closest("[data-testid]")?.getAttribute("data-testid");
    return id ? `[data-testid=${id}]` : `<${top.tagName.toLowerCase()}${top.id ? `#${top.id}` : ""}>`;
  };
  const boxOf = (e: Element): DOMRect | null => {
    const r = (e as HTMLElement).getBoundingClientRect();
    const s = window.getComputedStyle(e as HTMLElement);
    return s.visibility !== "hidden" && s.display !== "none" && r.width > 0 && r.height > 0 ? r : null;
  };
  // #357: `document.elementFromPoint` stops at a shadow host — drill through OPEN shadow roots to
  // the real topmost element (a closed root's `shadowRoot` is null: its host is the hit).
  const hitAt = (x: number, y: number): Element | null => {
    let top = document.elementFromPoint(x, y);
    for (let depth = 0; top !== null && top.shadowRoot !== null && depth < 32; depth += 1) {
      const inner = top.shadowRoot.elementFromPoint(x, y);
      if (inner === null || inner === top) break;
      top = inner;
    }
    return top;
  };
  // Containment across open shadow boundaries: `a` is `b` or an ancestor of it in the composed tree.
  const holds = (a: Element, b: Element): boolean => {
    for (let n: Node | null = b; n !== null; n = n instanceof ShadowRoot ? n.host : n.parentNode) {
      if (n === a) return true;
    }
    return false;
  };
  const probe = (r: DOMRect, own: (top: Element) => boolean): string | null => {
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    if (x < 0 || y < 0 || x >= window.innerWidth || y >= window.innerHeight) return null;
    const top = hitAt(x, y);
    if (top === null || own(top)) return null;
    return describe(top);
  };

  const style = window.getComputedStyle(el as HTMLElement);
  if (style.display === "none" || style.visibility === "hidden") return null;
  // An sr-only input is judged where a user clicks it: at its visible label (#90).
  if (el instanceof HTMLInputElement) {
    const r = el.getBoundingClientRect();
    const clip = style.clip.replace(/\s+/g, "");
    const srOnly =
      r.width <= 1 ||
      r.height <= 1 ||
      /^rect\(0(px)?,?0(px)?,?0(px)?,?0(px)?\)$/.test(clip) ||
      /inset\(50%\)|circle\(0/.test(style.clipPath) ||
      r.left <= -1_000 ||
      r.top <= -1_000;
    if (srOnly) {
      const labelledBy = (el.getAttribute("aria-labelledby") ?? "")
        .split(/\s+/)
        .map((id) => (id === "" ? null : (el.getRootNode() as Document | ShadowRoot).getElementById(id)))
        .filter((e): e is HTMLElement => e !== null);
      const candidates: Element[] = [...Array.from(el.labels ?? []), ...labelledBy];
      for (const label of candidates) {
        const box = boxOf(label);
        if (box === null) continue;
        return probe(box, (top) => holds(label, top) || holds(el, top));
      }
    }
  }
  const rect = boxOf(el);
  if (rect === null) return null;
  /**
   * #397: an OFF-SCREEN control is judged where scrolling it into view (centred, as act() does)
   * would bring it. Only a FIXED layer is trusted there — it stays put while the page scrolls under
   * it (a dialog's backdrop, a fixed dialog panel) — and only one that does not contain the control
   * (a fixed app shell whose inner scroller holds it is the control's own layer, not a cover).
   * Anything else at that point scrolls away with the page and proves nothing.
   */
  const fixedCoverAfterScroll = (r: DOMRect): string | null => {
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    if (cx >= 0 && cy >= 0 && cx < window.innerWidth && cy < window.innerHeight) return null;
    if (r.left <= -1_000 || r.top <= -1_000) return null;
    const doc = document.scrollingElement ?? document.documentElement;
    const land = (centre: number, scrolled: number, view: number, extent: number): number => {
      const target = Math.min(Math.max(scrolled + centre - view / 2, 0), Math.max(0, extent - view));
      return centre - (target - scrolled);
    };
    const x = cx >= 0 && cx < window.innerWidth ? cx : land(cx, doc.scrollLeft, window.innerWidth, doc.scrollWidth);
    const y = cy >= 0 && cy < window.innerHeight ? cy : land(cy, doc.scrollTop, window.innerHeight, doc.scrollHeight);
    if (x < 0 || y < 0 || x >= window.innerWidth || y >= window.innerHeight) return null;
    const top = hitAt(x, y);
    if (top === null || holds(el, top)) return null;
    let layer: Element | null = null;
    for (let n: Node | null = top; n !== null; n = n instanceof ShadowRoot ? n.host : n.parentNode) {
      if (n instanceof Element && window.getComputedStyle(n).position === "fixed") {
        layer = n;
        break;
      }
    }
    if (layer === null || holds(layer, el)) return null;
    return describe(top);
  };
  return probe(rect, (top) => holds(el, top)) ?? fixedCoverAfterScroll(rect);
}

/**
 * BROWSER CODE — does the SAME element that intercepted an earlier click (#90; parsed from
 * Playwright's failure message into a CSS selector by `parseInterceptor` in ./act.ts) still cover
 * this control's clickable point? A GEOMETRIC containment check against the interceptor's live box,
 * not a fresh `elementFromPoint` hit-test: the failed click already proved the interceptor covers a
 * real click there, so a control found within its current box is deprioritised without re-running
 * (and re-racing) the hit-test. An sr-only input is judged at its visible label's point, exactly like
 * `occluderOf`.
 */
export function coveredByInterceptors(node: Node, selectors: readonly string[]): boolean {
  const el = node as Element;
  const pointOf = (e: Element): { x: number; y: number } | null => {
    const r = (e as HTMLElement).getBoundingClientRect();
    const s = window.getComputedStyle(e as HTMLElement);
    if (s.visibility === "hidden" || s.display === "none" || r.width <= 0 || r.height <= 0) return null;
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  };
  let point: { x: number; y: number } | null = null;
  if (el instanceof HTMLInputElement) {
    const r = el.getBoundingClientRect();
    const style = window.getComputedStyle(el);
    const clip = style.clip.replace(/\s+/g, "");
    const srOnly =
      r.width <= 1 ||
      r.height <= 1 ||
      /^rect\(0(px)?,?0(px)?,?0(px)?,?0(px)?\)$/.test(clip) ||
      /inset\(50%\)|circle\(0/.test(style.clipPath) ||
      r.left <= -1_000 ||
      r.top <= -1_000;
    if (srOnly) {
      const labelledBy = (el.getAttribute("aria-labelledby") ?? "")
        .split(/\s+/)
        .map((id) => (id === "" ? null : (el.getRootNode() as Document | ShadowRoot).getElementById(id)))
        .filter((e): e is HTMLElement => e !== null);
      const candidates: Element[] = [...Array.from(el.labels ?? []), ...labelledBy];
      for (const label of candidates) {
        const p = pointOf(label);
        if (p !== null) {
          point = p;
          break;
        }
      }
    }
  }
  if (point === null) point = pointOf(el);
  if (point === null) return false;
  const p = point;
  for (const selector of selectors) {
    let matches: Element[];
    try {
      matches = Array.from(document.querySelectorAll(selector));
    } catch {
      continue;
    }
    for (const m of matches) {
      const s = window.getComputedStyle(m as HTMLElement);
      if (s.visibility === "hidden" || s.display === "none") continue;
      const r = (m as HTMLElement).getBoundingClientRect();
      if (p.x >= r.left && p.x <= r.right && p.y >= r.top && p.y <= r.bottom) return true;
    }
  }
  return false;
}

/**
 * BROWSER CODE — how a user activates a visually-hidden (sr-only) input: through its visible native
 * `<label>` (#90). Returns null when the input is not sr-only (it is clicked directly); otherwise
 * where its first rendered label is — `{ for: id, nth }` for a `<label for>` (the nth such label),
 * `{ wrap: true }` for a label wrapping the input — or `{ none: true }` when no visible label can
 * activate it (a user could not click it either).
 */
export function srOnlyLabelOf(node: Node): null | { readonly for: string; readonly nth: number } | { readonly wrap: true } | { readonly none: true } {
  const el = node as Element;
  if (!(el instanceof HTMLInputElement)) return null;
  const style = window.getComputedStyle(el);
  const r = el.getBoundingClientRect();
  const clip = style.clip.replace(/\s+/g, "");
  const srOnly =
    r.width <= 1 ||
    r.height <= 1 ||
    /^rect\(0(px)?,?0(px)?,?0(px)?,?0(px)?\)$/.test(clip) ||
    /inset\(50%\)|circle\(0/.test(style.clipPath) ||
    r.left <= -1_000 ||
    r.top <= -1_000;
  if (!srOnly) return null;
  for (const label of Array.from(el.labels ?? [])) {
    const lr = label.getBoundingClientRect();
    const ls = window.getComputedStyle(label);
    if (ls.visibility === "hidden" || ls.display === "none" || lr.width <= 1 || lr.height <= 1) continue;
    if (label.contains(el)) return { wrap: true };
    if (el.id !== "" && label.htmlFor === el.id) {
      const all = Array.from((el.getRootNode() as Document | ShadowRoot).querySelectorAll(`label[for="${CSS.escape(el.id)}"]`));
      return { for: el.id, nth: Math.max(0, all.indexOf(label)) };
    }
  }
  return { none: true };
}
