/** Raw per-control facts gathered in-page (safe values only). */
export interface ControlFacts {
  readonly tag: string;
  readonly inputType: string | null;
  readonly role: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly checked: boolean | null;
  /** The raw `autocomplete` attribute (a secret marker), or null. */
  readonly autocomplete: string | null;
  /**
   * True for a control whose value can be described (textarea, or a non-hidden,
   * non-file, non-button input). The value itself is NOT read here — it is read
   * in a second step, and only when `isSecretField` says the control is not a
   * secret (see `snapshot`).
   */
  readonly valueBearing: boolean;
  readonly visible: boolean;
  /** A file input's `accept` filter (e.g. `image/*`); null for every other control. */
  readonly accept: string | null;
  /** A `<select>`'s enabled, non-placeholder option labels; null for every other control. */
  readonly options: string[] | null;
  /** A `<select>`'s selected option label; null for every other control. */
  readonly selected: string | null;
  /** The owning form's key (`form#<id>` / `form@<n>`), or null. */
  readonly form: string | null;
  /** The nearest form-like container's key, computed only when `form` is null. See `Control.container`. */
  readonly container: string | null;
  /** The nearest named dialog/region, as the model reads it. See `Control.scope`. */
  readonly scope: string | null;
  /** The nearest visible heading before the control. See `Control.heading`. */
  readonly heading: string | null;
  /** Whether activating the control submits its form. */
  readonly submits: boolean;
  /** A link's resolved `href`, or null. */
  readonly href: string | null;
  /** The raw `aria-haspopup` attribute, or null — a disclosure signal (e.g. `dialog`). */
  readonly ariaHasPopup: string | null;
  /** The raw `aria-current` attribute, or null — marks the current nav item (#127). */
  readonly ariaCurrent: string | null;
  /** The raw `min` attribute, or null. */
  readonly min: string | null;
  /** The raw `max` attribute, or null. */
  readonly max: string | null;
  /** The raw `step` attribute, or null. */
  readonly step: string | null;
  /** The enclosing chrome landmark (`navigation` / `banner` / `contentinfo`), or null. */
  readonly landmark: "navigation" | "banner" | "contentinfo" | null;
  /** A rich-text (`contenteditable`, not input/textarea) element. See `Control.richText`. */
  readonly richText: boolean;
  /** See `Control.clippedOffscreen` (#75, #161). */
  readonly clippedOffscreen: boolean;
  /**
   * #272: a modal is open (`dialog:modal`, a visible `[aria-modal=true]`, or an open `<dialog>`
   * drawn as a fixed overlay over much of the viewport) and this control is outside it — a user
   * cannot reach it until the modal is dismissed, wherever it sits (even below the fold, where the
   * centre-point occlusion probe cannot see the overlay).
   */
  readonly outsideModal: boolean;
  /**
   * #294: the control's box lies wholly outside what the page can ever bring into view — a fixed
   * element (or one in a fixed panel, like a closed drawer translated off-screen) outside the
   * viewport, or an in-flow element outside the document's scrollable area. Never judged inside a
   * scroll container (scrolling it may reach the control) or for a visually-hidden (sr-only) one.
   */
  readonly unreachable: boolean;
  /** #287: a disclosure summary's state (its `<details>` open); null for every other control. */
  readonly expanded: boolean | null;
}

/**
 * BROWSER CODE — serialized by `handle.evaluate`: no imports, no closure over
 * module scope. Reads only *safe* facts: NO control's value is read here. The
 * secret decision (`isSecretField`, the predicate `@jevitate/recorder`'s
 * in-page capture listener also uses) is made Node-side from `inputType` +
 * `autocomplete`, and only a non-secret control's value is then fetched by
 * `readControlValue` — so a secret's plaintext cannot reach Node from here.
 */
export function readControlFacts(node: Node): ControlFacts {
  const el = node as Element;
  const norm = (s: string | null): string => (s === null ? "" : s.replace(/\s+/g, " ").trim());
  const tag = el.tagName.toLowerCase();
  const inputType = tag === "input" ? String((el as HTMLInputElement).type || "").toLowerCase() : null;
  // #357: a control inside an OPEN shadow root has ancestors across the boundary (its host, and the
  // host's own ancestors) — fixed panels, modals and landmarks are judged through it.
  const parentOf = (a: Element): Element | null =>
    a.parentElement ?? (a.parentNode instanceof ShadowRoot ? a.parentNode.host : null);
  const holds = (a: Element, b: Element): boolean => {
    for (let n: Element | null = b; n !== null; n = parentOf(n)) if (n === a) return true;
    return false;
  };

  const style = window.getComputedStyle(el as HTMLElement);
  const rect = (el as HTMLElement).getBoundingClientRect();
  // Rendered only; whether it is COVERED is decided separately by the shared `occluderOf`
  // predicate (./occlusion.ts) — the same one the pre-click act() gate uses.
  const visible =
    style.visibility !== "hidden" &&
    style.display !== "none" &&
    rect.width > 0 &&
    rect.height > 0;
  // The sr-only "skip link" clipping idiom (#75, #161) — mirrors `act.ts`'s
  // `isClippedOrPulledOffscreen` exactly (kept in sync by hand: BROWSER CODE here cannot import
  // it). A `visible` control per the check above (non-zero box, not display:none) can still be
  // clipped to near-nothing or pulled off-screen by a large negative offset.
  const clippedOffscreen = (rect.width <= 1 && rect.height <= 1) || rect.left <= -1_000 || rect.top <= -1_000;
  // #272: the open modal(s) — a control outside every one is behind it, however far down it sits.
  const modals = Array.from(document.querySelectorAll('dialog[open], [aria-modal="true"]')).filter((m) => {
    const ms = window.getComputedStyle(m as HTMLElement);
    const mr = (m as HTMLElement).getBoundingClientRect();
    if (ms.display === "none" || ms.visibility === "hidden" || mr.width <= 0 || mr.height <= 0) return false;
    // #441: a drawer that is inert, aria-hidden, or wholly off-viewport is not an open modal.
    if (m.closest("[inert]") !== null || m.closest('[aria-hidden="true"]') !== null) return false;
    if (mr.right <= 0 || mr.bottom <= 0 || mr.left >= window.innerWidth || mr.top >= window.innerHeight) return false;
    if (m.tagName.toLowerCase() !== "dialog") return true;
    let modal = false;
    try {
      modal = m.matches(":modal");
    } catch {
      modal = false;
    }
    // A non-modal `<dialog open>` blocks the page only when it is drawn as an overlay (fixed, large).
    return modal || (ms.position === "fixed" && mr.width * mr.height >= 0.25 * window.innerWidth * window.innerHeight);
  });
  const outsideModal = modals.length > 0 && !modals.some((m) => holds(m, el));
  // #294: wholly outside what scrolling can ever bring into view.
  let unreachable = false;
  if (!clippedOffscreen && rect.width > 0 && rect.height > 0) {
    let fixedBox: DOMRect | null = null;
    let scroller = false;
    for (let a: Element | null = el; a !== null && a !== document.documentElement; a = parentOf(a)) {
      const s = window.getComputedStyle(a as HTMLElement);
      if (s.position === "fixed") {
        fixedBox = (a as HTMLElement).getBoundingClientRect();
        break;
      }
      if (a !== el && a !== document.body && /(auto|scroll)/.test(`${s.overflowX} ${s.overflowY}`)) scroller = true;
    }
    const outside = (r: DOMRect, w: number, h: number, dx: number, dy: number): boolean =>
      r.right + dx <= 0 || r.bottom + dy <= 0 || r.left + dx >= w || r.top + dy >= h;
    if (fixedBox !== null) {
      // A fixed panel never scrolls: off the viewport (itself or the control in it) is unreachable.
      unreachable =
        outside(fixedBox, window.innerWidth, window.innerHeight, 0, 0) ||
        (!scroller && outside(rect, window.innerWidth, window.innerHeight, 0, 0));
    } else if (!scroller) {
      const root = document.scrollingElement ?? document.documentElement;
      unreachable = outside(rect, root.scrollWidth, root.scrollHeight, window.scrollX, window.scrollY);
    }
  }

  const roleAttr = norm(el.getAttribute("role")).split(" ")[0] ?? "";
  const roleByTag: Record<string, string> = {
    a: "link",
    button: "button",
    select: "combobox",
    textarea: "textbox",
    summary: "button",
  };
  const roleByInput: Record<string, string> = {
    button: "button",
    submit: "button",
    reset: "button",
    checkbox: "checkbox",
    radio: "radio",
    text: "textbox",
    email: "textbox",
    search: "searchbox",
    tel: "textbox",
    url: "textbox",
    password: "textbox",
    number: "spinbutton",
  };
  let role = roleAttr;
  // A file input is always `file-input` (the `upload` op's target), whatever
  // role attribute it carries — so the model recognises it unambiguously.
  if (inputType === "file") role = "file-input";
  else if (role === "") {
    if (tag === "input") role = roleByInput[inputType ?? "text"] ?? "textbox";
    else role = roleByTag[tag] ?? "";
  }

  // Accessible-name approximation in accname order: aria-label -> aria-labelledby -> label ->
  // own text -> placeholder -> value(button-ish) -> nested img alt -> title (#396).
  const ariaLabel = norm(el.getAttribute("aria-label"));
  // #396: accname resolves aria-labelledby to the space-joined text of the referenced ids.
  const labelledby = norm(
    (el.getAttribute("aria-labelledby") ?? "")
      .split(/\s+/)
      .map((id) => norm(id === "" ? null : (document.getElementById(id)?.textContent ?? null)))
      .join(" "),
  );
  let labelText = "";
  const labels = (el as unknown as { labels?: NodeListOf<HTMLLabelElement> }).labels;
  // A label that WRAPS a select also "contains" every option's text: strip the control's own text.
  const ownText = tag === "select" ? norm(el.textContent) : "";
  const labelOf = (l: Element): string => {
    const t = norm(l.textContent);
    return ownText !== "" && l.contains(el) ? norm(t.replace(ownText, " ")) : t;
  };
  if (labels && labels.length > 0) labelText = labelOf(labels[0]!);
  else {
    const owner = el.closest("label");
    if (owner) labelText = labelOf(owner);
  }
  const placeholder = norm(el.getAttribute("placeholder"));
  const buttonish = inputType === "button" || inputType === "submit" || inputType === "reset";
  // A select's own text is every option label run together — never its name. A text field's own
  // text (a textarea, a contenteditable editor, an explicit textbox/searchbox/combobox) is typed
  // content — never its name either (0.12.0 review M3).
  const typedText =
    tag === "select" || tag === "textarea" || (el as HTMLElement).isContentEditable === true || role === "textbox" || role === "searchbox" || role === "combobox";
  const own = typedText ? "" : norm(el.textContent);
  // #396: an icon-only control carries its name in a nested <img alt> (own text empty), or last in
  // its own `title` attribute.
  const imgAlt = own === "" ? norm(el.querySelector("img[alt]")?.getAttribute("alt") ?? null) : "";
  const title = norm(el.getAttribute("title"));
  const nameCandidates = [
    ariaLabel,
    labelledby,
    labelText,
    own,
    placeholder,
    buttonish ? norm((el as HTMLInputElement).value) : "",
    imgAlt,
    title,
  ];
  const name = nameCandidates.find((c) => c !== "") ?? "";

  const enabled = !(el as HTMLInputElement).disabled;
  const checked =
    inputType === "checkbox" || inputType === "radio" ? (el as HTMLInputElement).checked : null;

  const OPAQUE = new Set(["hidden", "file"]);
  const valueBearing =
    tag === "textarea" || (tag === "input" && inputType !== null && !OPAQUE.has(inputType) && !buttonish);
  const autocomplete = el.getAttribute("autocomplete");

  const accept = inputType === "file" ? norm(el.getAttribute("accept")) : null;

  let options: string[] | null = null;
  let selected: string | null = null;
  if (tag === "select") {
    const sel = el as HTMLSelectElement;
    options = Array.from(sel.options)
      .filter((o) => !o.disabled && o.value !== "")
      .map((o) => norm(o.label || o.text))
      .filter((o) => o !== "")
      .slice(0, 100);
    const cur = sel.selectedIndex >= 0 ? sel.options[sel.selectedIndex] : undefined;
    selected = cur === undefined ? null : norm(cur.label || cur.text);
  }

  // Form membership: the element's own form owner (honours the `form=` attribute), else the
  // nearest enclosing <form>. Keyed by id when it has one, else by its position in the document.
  const owner = (el as HTMLInputElement).form ?? el.closest("form");
  let form: string | null = null;
  if (owner !== null) {
    form = owner.id !== "" ? `form#${owner.id}` : `form@${Array.from(document.forms).indexOf(owner)}`;
  }
  // Form-LIKE container (#121): only computed when the control has no <form> owner. Lets a page
  // built without <form> elements still pair a field with its OWN submit (a settings section, a
  // dialog) instead of every form-less control on the page collapsing into one "page" bucket — the
  // bug behind pairing a global header search with an unrelated "Send feedback" button.
  let container: string | null = null;
  if (owner === null) {
    const CONTAINER_SELECTOR = '[role="form"], dialog, [role="dialog"], fieldset, section';
    const containerEl = el.closest(CONTAINER_SELECTOR);
    if (containerEl !== null) {
      const containerRole = norm(containerEl.getAttribute("role")).toLowerCase();
      const containerTag = containerEl.tagName.toLowerCase();
      const kind = containerRole === "form" ? "role-form" : containerRole === "dialog" ? "dialog" : containerTag;
      if (containerEl.id !== "") container = `${kind}#${containerEl.id}`;
      else {
        const all = Array.from(document.querySelectorAll(CONTAINER_SELECTOR));
        container = `${kind}@${all.indexOf(containerEl)}`;
      }
    }
  }
  // #182: the nearest dialog / region, named — what tells a trigger from its same-named confirm.
  let scope: string | null = null;
  const scopeEl = el.closest('dialog, [role="dialog"], [role="alertdialog"], [role="region"], section[aria-label], section[aria-labelledby], form[aria-label]');
  if (scopeEl !== null) {
    const kind = norm(scopeEl.getAttribute("role")).toLowerCase() || (scopeEl.tagName.toLowerCase() === "section" ? "region" : scopeEl.tagName.toLowerCase());
    const labelledBy = norm(scopeEl.getAttribute("aria-labelledby"))
      .split(" ")
      .filter((id) => id !== "")
      .map((id) => norm(document.getElementById(id)?.textContent ?? ""))
      .join(" ");
    const heading = norm(scopeEl.querySelector("h1, h2, h3, h4")?.textContent ?? "");
    const label = norm(scopeEl.getAttribute("aria-label")) || labelledBy || heading;
    scope = label === "" ? kind : `${kind} "${label}"`;
  }
  // #356: the heading the control sits under — the last visible heading before it in document
  // order (a heading that CONTAINS the control is not before it). A hidden screen's heading is skipped.
  let sectionHeading: string | null = null;
  for (const h of Array.from(document.querySelectorAll('h1, h2, h3, h4, h5, h6, [role="heading"]'))) {
    if (h.contains(el)) continue;
    if ((h.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) === 0) break;
    const t = norm(h.textContent);
    if (t !== "" && h.getClientRects().length > 0) sectionHeading = t;
  }
  const buttonType = tag === "button" ? (el.getAttribute("type") ?? "submit").toLowerCase() : null;
  const submits =
    owner !== null && (buttonType === "submit" || inputType === "submit" || inputType === "image");
  const href = tag === "a" ? (el as HTMLAnchorElement).href || null : null;
  const ariaHasPopup = norm(el.getAttribute("aria-haspopup")).toLowerCase() || null;
  const ariaCurrent = norm(el.getAttribute("aria-current")).toLowerCase() || null;
  const min = tag === "input" ? el.getAttribute("min") : null;
  const max = tag === "input" ? el.getAttribute("max") : null;
  const step = tag === "input" ? el.getAttribute("step") : null;
  const richText = (el as HTMLElement).isContentEditable === true && tag !== "input" && tag !== "textarea";
  // Chrome landmark: a <nav>/role=navigation anywhere up the tree, or a PAGE-level <header>/<footer>
  // (one inside an article/section/main/aside is that region's own header, not page chrome).
  let landmark: "navigation" | "banner" | "contentinfo" | null = null;
  for (let a: Element | null = parentOf(el); a !== null; a = parentOf(a)) {
    const r = (a.getAttribute("role") ?? "").toLowerCase();
    const t = a.tagName.toLowerCase();
    if (r === "navigation" || t === "nav") {
      landmark = "navigation";
      break;
    }
    if (r === "banner" || r === "contentinfo") {
      landmark = r;
      break;
    }
    if ((t === "header" || t === "footer") && (a.parentElement?.closest("article,aside,main,section") ?? null) === null) {
      landmark = t === "header" ? "banner" : "contentinfo";
      break;
    }
  }

  return {
    tag,
    inputType,
    role,
    name,
    enabled,
    checked,
    autocomplete,
    valueBearing,
    visible,
    accept,
    options,
    selected,
    form,
    container,
    scope,
    heading: sectionHeading,
    submits,
    href,
    ariaHasPopup,
    ariaCurrent,
    min,
    max,
    step,
    landmark,
    richText,
    clippedOffscreen,
    outsideModal,
    unreachable,
    expanded: tag === "summary" ? (el.parentElement as HTMLDetailsElement | null)?.open === true : null,
  };
}

/** BROWSER CODE — reads a (non-secret, value-bearing) control's current value. */

/**
 * BROWSER CODE — serialized by `evaluateAll`: for each candidate that is an item of an ARIA list
 * (explicit role in `roles`), its list (the index of its nearest list container), its visible name
 * and whether it renders; `null` for every other candidate.
 */
export function readListItems(els: Element[], roles: string[]): Array<{ list: number; name: string; visible: boolean } | null> {
  const LIST = '[role=listbox],[role=menu],[role=menubar],[role=tablist],[role=radiogroup],[role=tree],[role=grid],ul,ol';
  const lists: Element[] = [];
  return els.map((el) => {
    const role = (el.getAttribute("role") ?? "").toLowerCase();
    if (!roles.includes(role)) return null;
    const container = el.parentElement?.closest(LIST) ?? el.parentElement ?? el;
    let list = lists.indexOf(container);
    if (list === -1) {
      lists.push(container);
      list = lists.length - 1;
    }
    const name = (el.getAttribute("aria-label") ?? el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
    const style = getComputedStyle(el);
    const visible = el.getClientRects().length > 0 && style.visibility !== "hidden" && style.display !== "none";
    return { list, name, visible };
  });
}

/**
 * BROWSER CODE — serialized by `evaluateAll`: no imports, no closure. #519: for each candidate, whether
 * it is one of `regions` or inside one, across OPEN shadow roots (as `readControlFacts`' `holds`).
 */
export function markInRegion(els: Element[], regions: Node[]): boolean[] {
  const parentOf = (a: Element): Element | null =>
    a.parentElement ?? (a.parentNode instanceof ShadowRoot ? a.parentNode.host : null);
  return els.map((el) => {
    for (let n: Element | null = el; n !== null; n = parentOf(n)) if (regions.includes(n)) return true;
    return false;
  });
}

/** BROWSER CODE — each candidate's approximate accessible name (aria-label, aria-labelledby, label, text, placeholder, title). */
export function readCheapNames(els: Element[]): string[] {
  const norm = (s: string | null | undefined): string => (s ?? "").replace(/\s+/g, " ").trim();
  return els.map((el) => {
    const labels = (el as unknown as { labels?: NodeListOf<HTMLLabelElement> }).labels;
    // #396: agree with readControlFacts on aria-labelledby and the trailing title fallback.
    const labelledby = norm(
      (el.getAttribute("aria-labelledby") ?? "")
        .split(/\s+/)
        .map((id) => (id === "" ? "" : norm(document.getElementById(id)?.textContent)))
        .join(" "),
    );
    return (
      norm(el.getAttribute("aria-label")) ||
      labelledby ||
      norm(labels?.[0]?.textContent) ||
      (el.tagName.toLowerCase() === "select" ? "" : norm(el.textContent)) ||
      norm(el.getAttribute("placeholder")) ||
      norm(el.getAttribute("title"))
    ).slice(0, 200);
  });
}

