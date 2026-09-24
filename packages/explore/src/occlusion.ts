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
 * Off-screen or unrendered controls are not "covered" (they cannot be probed with
 * `elementFromPoint`; scrolling reaches them), so this returns null for them.
 *
 * A VISUALLY-HIDDEN input (the sr-only idiom: clipped to ≤1px, `clip`/`clip-path` to nothing, or
 * pulled far off-screen) is never what a user clicks — its visible `<label>` (or `aria-labelledby`
 * element) is (#90). Its own centre is not hit-testable, so probing there lands on whatever happens
 * to be underneath (its label, the page, or NOT the overlay covering the label). For such an input
 * the probe runs at its label's centre instead; the label, anything inside it, or the input itself
 * on top is the control's own surface, anything else covers it.
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
  const probe = (r: DOMRect, own: (top: Element) => boolean): string | null => {
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    if (x < 0 || y < 0 || x >= window.innerWidth || y >= window.innerHeight) return null;
    const top = document.elementFromPoint(x, y);
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
        .map((id) => (id === "" ? null : document.getElementById(id)))
        .filter((e): e is HTMLElement => e !== null);
      const candidates: Element[] = [...Array.from(el.labels ?? []), ...labelledBy];
      for (const label of candidates) {
        const box = boxOf(label);
        if (box === null) continue;
        return probe(box, (top) => label === top || label.contains(top) || top === el || el.contains(top));
      }
    }
  }
  const rect = boxOf(el);
  if (rect === null) return null;
  return probe(rect, (top) => top === el || el.contains(top));
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
        .map((id) => (id === "" ? null : document.getElementById(id)))
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
      const all = Array.from(document.querySelectorAll(`label[for="${CSS.escape(el.id)}"]`));
      return { for: el.id, nth: Math.max(0, all.indexOf(label)) };
    }
  }
  return { none: true };
}
