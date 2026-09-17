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
      const autocomplete = (el.getAttribute("autocomplete") || "").toLowerCase();
      const secret = inputType === "password" || autocomplete.indexOf("one-time-code") !== -1;

      if (event.type === "click" || event.type === "submit") {
        payload.rawText = (el.textContent || "").trim();
      } else if (!secret && (event.type === "input" || event.type === "change")) {
        payload.rawText = String((el as HTMLInputElement).value ?? "");
      }
      // keydown carries no rawText at all: it exists for inter-keystroke
      // timing, never for content.

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
