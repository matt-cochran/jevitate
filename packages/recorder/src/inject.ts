/**
 * The in-page capture listener.
 *
 * THIS FILE IS BROWSER CODE. `installRecorderListener` is handed to
 * `page.addInitScript`, which serializes it with `Function.prototype.toString`
 * and evaluates the source in every new document of every frame. Therefore:
 *
 *  - zero imports (nothing Node-side survives serialization),
 *  - zero references to anything outside the function body (a closure over a
 *    module-level `const` typechecks but throws at runtime in the page),
 *  - only `window` / `document` / DOM APIs,
 *  - small and defensive: no descriptor computation, no redaction assembly.
 *    Those are Node-side concerns.
 *
 * Type-only declarations below are erased at compile time, so they are safe.
 *
 * ┌─ DUPLICATED LOGIC — KEEP IN STEP WITH `descriptor.ts` ─────────────────┐
 * │ `gatherFacts` below is a line-for-line copy of `readElementFacts` in    │
 * │ `descriptor.ts`, and the two MUST keep producing the same object for    │
 * │ the same element: a descriptor built from one is validated against a    │
 * │ page queried by the other, and Task 4's ladder tests exercise only the  │
 * │ `descriptor.ts` copy. Change one, check the other.                      │
 * │                                                                         │
 * │ It cannot be shared. The serialization rules above forbid an import,    │
 * │ and passing the function in is not possible either: `addInitScript`     │
 * │ arguments are JSON, so a function argument would arrive as `{}`. The    │
 * │ duplication is the price of gathering these facts *synchronously,       │
 * │ inside the event handler*, which is the whole point — see `gatherFacts` │
 * │ for why a Node-side read loses the race against a navigating click.     │
 * └─────────────────────────────────────────────────────────────────────────┘
 */

interface RecorderWindow {
  __doitRecorderArmed?: boolean;
  __doitEidCounter?: number;
  __doitRecord?: (payload: Record<string, unknown>) => void;
}

/**
 * Installs capture-phase listeners for `click`, `input`, `change`, `keydown`
 * and `submit` on `document`.
 *
 * Capture phase (rather than bubble) is deliberate: it sees the event before
 * page code can call `stopPropagation()`, so an app that swallows its own
 * events is still recorded.
 */
export function installRecorderListener(): void {
  const w = window as unknown as RecorderWindow;
  if (w.__doitRecorderArmed === true) return;
  w.__doitRecorderArmed = true;
  if (typeof w.__doitEidCounter !== "number") w.__doitEidCounter = 0;

  // Everything below lives inside the function body on purpose: a reference to
  // a module-level `const` typechecks here and throws in the page.

  /** `descriptor.ts`'s `GENERATED_PATTERNS`. Keep in step. */
  const GENERATED_PATTERNS = [
    "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}",
    "[0-9a-fA-F]{8}",
    "[0-9]{4}",
  ];
  /** `descriptor.ts`'s `VALUE_NAMED_INPUT_TYPES`. Keep in step. */
  const VALUE_NAMED_INPUT_TYPES = ["button", "submit", "reset"];
  const CSS_IDENT = /^[A-Za-z_][A-Za-z0-9_-]*$/;

  /**
   * The DOM facts a descriptor is built from, read **synchronously, in the
   * capture-phase handler, before the browser's default action runs**.
   *
   * That timing is the entire reason this function exists rather than being
   * left to `descriptor.ts`'s identical `readElementFacts`. Reading the facts
   * from Node needs a round trip per question, and a click on a submit button
   * (or a link) has already replaced the document by the time the first answer
   * comes back — the read then lands on the *new* page, finds nothing, and the
   * action degrades to a `handback`. Read here, the facts are unconditionally
   * the facts of the element the user actually acted on.
   *
   * Mirror of `readElementFacts` in `descriptor.ts` — see this file's header.
   */
  const gatherFacts = (el: Element): Record<string, unknown> => {
    const norm = (s: string | null): string => (s === null ? "" : s.replace(/\s+/g, " ").trim());
    const attr = (name: string): string | null => el.getAttribute(name);
    const isGenerated = (v: string): boolean =>
      GENERATED_PATTERNS.some((p) => new RegExp(p).test(v));

    const segmentFor = (target: Element): { text: string; anchor: boolean } => {
      const id = target.getAttribute("id");
      if (
        id !== null &&
        CSS_IDENT.test(id) &&
        !isGenerated(id) &&
        document.querySelectorAll("#" + id).length === 1
      ) {
        return { text: "#" + id, anchor: true };
      }
      const tagName = target.tagName.toLowerCase();
      const parent = target.parentElement;
      if (parent !== null) {
        const sameTag = Array.prototype.filter.call(
          parent.children,
          (c: Element) => c.tagName === target.tagName,
        ) as Element[];
        if (sameTag.length > 1) {
          return {
            text: tagName + ":nth-of-type(" + String(sameTag.indexOf(target) + 1) + ")",
            anchor: false,
          };
        }
      }
      return { text: tagName, anchor: false };
    };

    const cssPath = (): string | null => {
      const segments: string[] = [];
      let cursor: Element | null = el;
      while (cursor !== null) {
        const segment = segmentFor(cursor);
        segments.unshift(segment.text);
        const selector = segments.join(" > ");
        const matches = document.querySelectorAll(selector);
        if (matches.length === 1 && matches[0] === el) return selector;
        if (segment.anchor) return null;
        cursor = cursor.parentElement;
      }
      return null;
    };

    let labelText: string | null = null;
    const labels = (el as unknown as { labels?: NodeListOf<HTMLLabelElement> }).labels;
    if (labels !== undefined && labels !== null && labels.length > 0) {
      labelText = norm(labels[0]!.textContent);
    } else {
      const owner = el.closest("label");
      if (owner !== null) labelText = norm(owner.textContent);
    }

    const tagName = el.tagName.toLowerCase();
    const roleAttr = norm(attr("role")).split(" ")[0] ?? "";
    const type =
      tagName === "input" ? String((el as HTMLInputElement).type || "").toLowerCase() : null;

    // `value` is read ONLY for the input types whose accessible name comes from
    // it (button/submit/reset). Reading it for every `<input>` would pull a
    // password or a one-time code out of the page and over the CDP connection,
    // where protocol logging or a trace could put it on disk. Same gate as
    // `descriptor.ts`'s `readElementFacts`, and just as load-bearing here.
    const namedByValue = type !== null && VALUE_NAMED_INPUT_TYPES.indexOf(type) !== -1;

    return {
      tag: tagName,
      roleAttr: roleAttr === "" ? null : roleAttr,
      hasHref: el.hasAttribute("href"),
      inputType: type,
      selectIsMulti:
        tagName === "select" &&
        (el.hasAttribute("multiple") || Number(attr("size") ?? "1") > 1),
      ariaLabel: attr("aria-label"),
      text: norm(el.textContent),
      alt: attr("alt"),
      title: attr("title"),
      value: namedByValue ? String((el as HTMLInputElement).value ?? "") : null,
      labelText: labelText === "" ? null : labelText,
      testId: attr("data-testid") ?? attr("data-test"),
      css: cssPath(),
    };
  };

  const handle = (event: Event): void => {
    try {
      const target = event.target as Node | null;
      if (target === null || target.nodeType !== 1) return;
      let el = target as Element;

      // A click often lands on a <span> inside a <button>; record the closest
      // interactive ancestor instead, which is what the user meant to act on.
      if (event.type === "click") {
        const interactive = el.closest(
          "a,button,input,select,textarea,label,summary,[role],[contenteditable],[tabindex],[onclick]",
        );
        if (interactive !== null) el = interactive;
      }

      // Our own recorder UI is never recorded: no tag, no eid, no event.
      if (el.closest("[data-doit-recorder]") !== null) return;

      let eid = el.getAttribute("data-doit-eid");
      if (eid === null) {
        const next = (typeof w.__doitEidCounter === "number" ? w.__doitEidCounter : 0) + 1;
        w.__doitEidCounter = next;
        eid = String(next);
        el.setAttribute("data-doit-eid", eid);
      }

      const tag = el.tagName.toLowerCase();
      const payload: Record<string, unknown> = { eid: eid, kind: event.type, tag: tag, ts: Date.now() };

      const inputType = tag === "input" ? String((el as HTMLInputElement).type || "").toLowerCase() : "";
      if (tag === "input") payload.typeAttr = inputType;

      // Secret fields: their value is never read, so it cannot leave the page.
      // Both autocomplete spellings need their own clause: "one-time-code"
      // does not contain "otp" as a substring.
      const autocomplete = (el.getAttribute("autocomplete") || "").toLowerCase();
      const secret =
        inputType === "password" ||
        autocomplete.indexOf("one-time-code") !== -1 ||
        autocomplete.indexOf("otp") !== -1;

      if (event.type === "click" || event.type === "submit") {
        payload.rawText = (el.textContent || "").trim();
      } else if (!secret && (event.type === "input" || event.type === "change")) {
        payload.rawText = String((el as HTMLInputElement).value ?? "");
      }
      // keydown carries no rawText at all: it exists for inter-keystroke
      // timing, never for content.

      // Facts are gathered only for the kinds that become a Step and therefore
      // need a descriptor (`keydown`/`submit` never do — see `assemble.ts`), so
      // no keystroke pays for a css-path walk it will never use.
      if (event.type === "click" || event.type === "input" || event.type === "change") {
        payload.facts = gatherFacts(el);
      }
      // The document this action happened in. Node compares it against the
      // frame's current URL to tell whether the page has moved on since, which
      // is what makes live validation of the facts best-effort rather than a
      // race it is bound to lose.
      payload.docUrl = document.location.href;

      const record = w.__doitRecord;
      if (typeof record === "function") record(payload);
    } catch {
      // A DOM quirk (detached node, cross-origin access, exotic target) must
      // never throw out of a page event listener.
    }
  };

  const kinds = ["click", "input", "change", "keydown", "submit"];
  for (const kind of kinds) document.addEventListener(kind, handle, true);
}
