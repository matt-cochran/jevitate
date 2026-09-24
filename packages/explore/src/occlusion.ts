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
 * BROWSER CODE — serialized by `evaluate`: no imports, no closure over module scope.
 * Returns a description of the covering element (`[data-testid=…]` of its nearest test id, else
 * `<tag#id>`), or null when the control is not covered.
 */
export function occluderOf(node: Node): string | null {
  const el = node as Element;
  const rect = (el as HTMLElement).getBoundingClientRect();
  const style = window.getComputedStyle(el as HTMLElement);
  const rendered = style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
  if (!rendered) return null;
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;
  if (x < 0 || y < 0 || x >= window.innerWidth || y >= window.innerHeight) return null;
  const top = document.elementFromPoint(x, y);
  if (top === null || top === el || el.contains(top)) return null;
  const id = top.closest("[data-testid]")?.getAttribute("data-testid");
  return id ? `[data-testid=${id}]` : `<${top.tagName.toLowerCase()}${top.id ? `#${top.id}` : ""}>`;
}
