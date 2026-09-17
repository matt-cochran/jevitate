import type { ElementHandle, Locator, Page } from "playwright";
import type { TargetDescriptor } from "@doit/recording";

/**
 * Node-side descriptor computation (RxD design §5c, "Descriptor computed
 * Node-side, validated as Playwright resolves it").
 *
 * Given a live `ElementHandle`, walk the binding selector ladder
 * (`testId > role+name > label > text > css`), build a candidate descriptor at
 * every rung the DOM supports, then **prove each candidate against the live
 * page**: it must resolve to exactly one element AND that element must be the
 * very node the handle points at. The highest rung that passes becomes the
 * descriptor; the lower rungs that also passed are kept as `alternates` for
 * future self-healing.
 *
 * Uniqueness alone is not enough. `count() === 1` only says "this selector
 * means one element" — not "it means *this* element". A css path derived one
 * sibling off, or a `role`/`name` approximation that happens to match a
 * different single element, would sail through a count check and then act on
 * the wrong thing at replay time. `resolvesToSameElement` closes that gap.
 */

// === Public shape ===

export type Stability = "high" | "medium" | "low";

/** The ladder rung a candidate came from; diagnostic, and the ranking key. */
export type Rung = "testId" | "roleName" | "label" | "text" | "css";

export interface DescriptorCandidate {
  readonly rung: Rung;
  readonly descriptor: TargetDescriptor;
  readonly stability: Stability;
}

export interface ComputedDescriptor {
  /** The highest-ranked rung that validated against the live page. */
  readonly descriptor: TargetDescriptor;
  readonly stability: Stability;
  /** Lower rungs that also validated, in ladder order. For self-healing. */
  readonly alternates: TargetDescriptor[];
}

/** The temporary attribute the in-page capture listener tags acted elements with. */
export const EID_ATTRIBUTE = "data-doit-eid";

// === Stability heuristics ===

/**
 * Patterns that make an identifying value look machine-generated (§5c: "avoid
 * generated-looking ids (uuid / long-hex / digit-runs)"). Each is an unanchored
 * source string, matched anywhere in the value:
 *
 *  1. a canonical UUID (8-4-4-4-12 hex, dash-separated),
 *  2. a run of 8+ consecutive hex characters (`a1b2c3d4`, `8f3a91c7` — this
 *     also subsumes (1), but (1) is spelled out because the design names it),
 *  3. a run of 4+ consecutive digits (`item-8234719`, `…-7890`).
 *
 * The threshold on (3) is deliberately 4, not 2: `step-3`, `h2` and `line-12`
 * are ordinary authored names, while a four-digit run is almost always an id,
 * a timestamp or a counter. (2) can in principle flag an authored word made
 * only of `[a-f0-9]`, which is rare enough to accept — and the consequence is
 * only a "review this" flag, never a rejected descriptor.
 *
 * Kept as source strings rather than `RegExp` literals because the in-page
 * css-path builder needs the same heuristic and cannot close over module
 * scope: the patterns are handed to it as an argument, so there is exactly one
 * definition of "looks generated" in this package.
 */
const GENERATED_PATTERNS: readonly string[] = [
  "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}",
  "[0-9a-fA-F]{8}",
  "[0-9]{4}",
];

export function looksGenerated(value: string): boolean {
  return GENERATED_PATTERNS.some((source) => new RegExp(source).test(value));
}

// === Role mapping ===

/**
 * Implicit ARIA roles by tag name. Deliberately NOT the full W3C HTML-AAM
 * table: it covers the interactive and landmark elements a recorded journey
 * actually acts on, plus enough structure for assertions. Anything not listed
 * (`div`, `span`, `p`, `label`, `input[type=password]`, …) yields no role, so
 * the role+name rung is skipped and the ladder falls through — which is the
 * safe direction, since a *wrong* role would be caught by validation anyway.
 *
 * Context-dependent cases are handled in `roleOf` rather than here:
 * `a`/`area` need an `href`, `select` becomes `listbox` when multi-select, and
 * `input` is dispatched on its `type`.
 */
const ROLE_BY_TAG: Readonly<Record<string, string>> = {
  a: "link",
  area: "link",
  button: "button",
  textarea: "textbox",
  select: "combobox",
  img: "img",
  option: "option",
  h1: "heading",
  h2: "heading",
  h3: "heading",
  h4: "heading",
  h5: "heading",
  h6: "heading",
  ul: "list",
  ol: "list",
  menu: "list",
  li: "listitem",
  table: "table",
  tr: "row",
  td: "cell",
  th: "columnheader",
  nav: "navigation",
  main: "main",
  header: "banner",
  footer: "contentinfo",
  aside: "complementary",
  form: "form",
  search: "search",
  dialog: "dialog",
  section: "region",
  fieldset: "group",
  progress: "progressbar",
  output: "status",
  hr: "separator",
};

/**
 * Implicit roles for `<input>` by `type`. Types absent from this map have no
 * ARIA role at all (`password`, `hidden`, `file`, `color`, and the date/time
 * family), so they intentionally produce no role+name candidate.
 */
const ROLE_BY_INPUT_TYPE: Readonly<Record<string, string>> = {
  button: "button",
  submit: "button",
  reset: "button",
  image: "button",
  checkbox: "checkbox",
  radio: "radio",
  range: "slider",
  number: "spinbutton",
  search: "searchbox",
  text: "textbox",
  email: "textbox",
  tel: "textbox",
  url: "textbox",
};

/** HTML's own `type` keywords. Anything else falls back to `text`, per spec. */
const KNOWN_INPUT_TYPES: ReadonlySet<string> = new Set([
  "button", "checkbox", "color", "date", "datetime-local", "email", "file",
  "hidden", "image", "month", "number", "password", "radio", "range", "reset",
  "search", "submit", "tel", "text", "time", "url", "week",
]);

/**
 * `<input type=…>` values whose accessible name comes from `value` — and, by
 * the same token, the ONLY input types whose `value` the in-page fact reader is
 * allowed to touch. Every other input's value (a password, a one-time code, a
 * message being composed) is never read at all.
 */
const VALUE_NAMED_INPUT_TYPES: ReadonlySet<string> = new Set(["button", "submit", "reset"]);

// === In-page fact gathering ===

/**
 * The raw DOM facts the ladder is built from. Every field is a primitive, so
 * Node does the interpretation (role mapping, name priority, stability) and
 * the browser only reports what it can see.
 */
export interface ElementFacts {
  readonly tag: string;
  /** First token of an explicit `role` attribute, if any. */
  readonly roleAttr: string | null;
  readonly hasHref: boolean;
  readonly inputType: string | null;
  readonly selectIsMulti: boolean;
  readonly ariaLabel: string | null;
  /** Whitespace-normalized `textContent`. */
  readonly text: string;
  readonly alt: string | null;
  readonly title: string | null;
  readonly value: string | null;
  /** Whitespace-normalized text of the associated `<label>`, if any. */
  readonly labelText: string | null;
  readonly testId: string | null;
  /** Shortest unique css path found, or `null` if none could be proven. */
  readonly css: string | null;
}

/**
 * The knowledge `readElementFacts` needs but cannot close over. Both lists have
 * exactly one definition in this module and are handed to the page as data,
 * because browser code cannot reference module scope.
 */
export interface ReadFactsOptions {
  readonly generatedPatterns: string[];
  /** `<input type=…>` values whose accessible name comes from `value`. */
  readonly valueNamedInputTypes: string[];
}

/**
 * THIS FUNCTION IS BROWSER CODE. It is serialized by `handle.evaluate`, so it
 * must have zero imports and zero references to anything outside its own body
 * — hence the inlined helpers and the `options` argument (the shared knowledge
 * it needs, passed in rather than closed over).
 *
 * Exported for `descriptor.test.ts`, which asserts directly that a password
 * field's value is never among the facts this returns. That guarantee is not
 * observable from `computeDescriptor`'s return value — the point is what is
 * *not* read, not what is emitted — so the only honest test calls this.
 *
 * The css path is built here rather than in Node because proving a path unique
 * requires `document.querySelectorAll` *and* a node-identity comparison, both
 * of which only exist in the page. The walk starts at the element's own
 * segment and prepends one ancestor at a time, returning the first path that
 * matches exactly one element and that element is the target — so a short path
 * is preferred over a full `html > body > …` chain. A segment is `#id` when the
 * id is a plain css identifier, document-unique, and does not look generated;
 * otherwise it is the tag name, with `:nth-of-type(n)` added only when the
 * element has same-tag siblings.
 */
export function readElementFacts(node: Node, options: ReadFactsOptions): ElementFacts {
  const el = node as Element;
  const norm = (s: string | null): string => (s === null ? "" : s.replace(/\s+/g, " ").trim());
  const attr = (name: string): string | null => el.getAttribute(name);
  const isGenerated = (v: string): boolean =>
    options.generatedPatterns.some((p) => new RegExp(p).test(v));
  const CSS_IDENT = /^[A-Za-z_][A-Za-z0-9_-]*$/;

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
    const tag = target.tagName.toLowerCase();
    const parent = target.parentElement;
    if (parent !== null) {
      const sameTag = Array.prototype.filter.call(
        parent.children,
        (c: Element) => c.tagName === target.tagName,
      ) as Element[];
      if (sameTag.length > 1) {
        return { text: tag + ":nth-of-type(" + String(sameTag.indexOf(target) + 1) + ")", anchor: false };
      }
    }
    return { text: tag, anchor: false };
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
      // A document-unique id anchors the path: no ancestor can narrow it
      // further, so there is nothing left to try.
      if (segment.anchor) return null;
      cursor = cursor.parentElement;
    }
    return null;
  };

  // `.labels` is the browser's own answer to "which <label> labels this
  // control", and it already covers both `for=`/`id=` pairing and a control
  // nested inside its label. `closest("label")` is the fallback for elements
  // that have no `.labels` (anything not labelable).
  let labelText: string | null = null;
  const labels = (el as unknown as { labels?: NodeListOf<HTMLLabelElement> }).labels;
  if (labels !== undefined && labels !== null && labels.length > 0) {
    labelText = norm(labels[0]!.textContent);
  } else {
    const owner = el.closest("label");
    if (owner !== null) labelText = norm(owner.textContent);
  }

  const tag = el.tagName.toLowerCase();
  const roleAttr = norm(attr("role")).split(" ")[0] ?? "";
  const inputType = tag === "input" ? String((el as HTMLInputElement).type || "").toLowerCase() : null;

  // `value` is read ONLY for the handful of input types whose accessible name
  // comes from it (button/submit/reset). Reading it for every `<input>` — as
  // this once did — meant a password field's value was pulled into this return
  // object and shipped back over the CDP connection, where `DEBUG=pw:protocol`,
  // a Playwright trace or any protocol-level logging could put it on disk.
  // Nothing downstream ever used it, so it was a secret in flight for no
  // reason. Task 3's "the value is never read in the page" guarantee is only
  // absolute if this respects it too.
  const namedByValue = inputType !== null && options.valueNamedInputTypes.indexOf(inputType) !== -1;

  return {
    tag: tag,
    roleAttr: roleAttr === "" ? null : roleAttr,
    hasHref: el.hasAttribute("href"),
    inputType: inputType,
    selectIsMulti:
      tag === "select" &&
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
}

// === Ladder construction ===

/** Explicit `role` wins; otherwise the documented implicit mapping. */
function roleOf(facts: ElementFacts): string | undefined {
  if (facts.roleAttr !== null) return facts.roleAttr;

  if (facts.tag === "input") {
    const raw = facts.inputType ?? "";
    const type = KNOWN_INPUT_TYPES.has(raw) ? raw : "text";
    return ROLE_BY_INPUT_TYPE[type];
  }
  if (facts.tag === "a" || facts.tag === "area") return facts.hasHref ? "link" : undefined;
  if (facts.tag === "select") return facts.selectIsMulti ? "listbox" : "combobox";
  return ROLE_BY_TAG[facts.tag];
}

/**
 * Accessible-name *approximation*, in the priority order the plan fixes:
 * `aria-label` → trimmed visible text → `alt` → `title`. One addition:
 * `<input type=button|submit|reset>` takes its name from `value`, since such
 * an element has no text content at all and would otherwise never reach the
 * role+name rung. `value` slots in where text content would have been.
 *
 * Deliberately NOT part of the name: an associated `<label>` (real ARIA name
 * computation would include it). Keeping label out of the name is what makes
 * the `label` rung meaningful — a labelled `<input>` lands on `{label}`
 * rather than on a `{role, name}` derived from the same words. `aria-labelledby`
 * is also out of scope; such an element falls through to a lower rung.
 */
function accessibleNameOf(facts: ElementFacts): string | undefined {
  const candidates: (string | null)[] = [facts.ariaLabel, facts.text];
  if (facts.tag === "input" && VALUE_NAMED_INPUT_TYPES.has(facts.inputType ?? "")) {
    candidates.push(facts.value);
  }
  candidates.push(facts.alt, facts.title);

  for (const candidate of candidates) {
    if (candidate === null) continue;
    const name = candidate.replace(/\s+/g, " ").trim();
    if (name !== "") return name;
  }
  return undefined;
}

/**
 * Builds one candidate per rung the facts support, in ladder order. A rung
 * with no underlying data is simply skipped — nothing is invented, and
 * nothing is filtered yet: validation is a separate step on purpose, so a
 * heuristic that guessed wrong is caught by the page rather than trusted.
 */
function buildCandidates(facts: ElementFacts): DescriptorCandidate[] {
  const candidates: DescriptorCandidate[] = [];

  if (facts.testId !== null && facts.testId !== "") {
    candidates.push({
      rung: "testId",
      descriptor: { testId: facts.testId },
      stability: looksGenerated(facts.testId) ? "low" : "high",
    });
  }

  const role = roleOf(facts);
  const name = accessibleNameOf(facts);
  if (role !== undefined && role !== "" && name !== undefined) {
    candidates.push({
      rung: "roleName",
      descriptor: { role, name },
      stability: looksGenerated(name) ? "low" : "high",
    });
  }

  if (facts.labelText !== null) {
    candidates.push({ rung: "label", descriptor: { label: facts.labelText }, stability: "medium" });
  }

  if (facts.text !== "") {
    candidates.push({ rung: "text", descriptor: { text: facts.text }, stability: "medium" });
  }

  // css is unconditionally low stability — it is the rung the design says to
  // flag for review, and the in-page builder has already refused to put a
  // generated-looking id into it.
  if (facts.css !== null) {
    candidates.push({ rung: "css", descriptor: { css: facts.css }, stability: "low" });
  }

  return candidates;
}

// === Validation ===

/**
 * Resolves a descriptor to a `Locator` exactly the way `@doit/interpreter`'s
 * `descriptorToTarget` will at replay time (same rung order, same Playwright
 * APIs), so a descriptor proven here is a descriptor that replays.
 *
 * This duplicates ~15 lines of the interpreter rather than importing it:
 * `@doit/recorder`'s intended dependencies are `@doit/recording`,
 * `@doit/playwright`, `@doit/screenplay` and `playwright`, and reaching into
 * `@doit/interpreter` would add an edge outside that graph — recorder and
 * interpreter are meant to meet only through the recording schema. The two
 * must be changed together; the ladder order is fixed by the design spec
 * (§4/§8), which is what actually keeps them in step.
 */
function descriptorToLocator(page: Page, d: TargetDescriptor): Locator {
  if (d.testId !== undefined) return page.getByTestId(d.testId);
  if (d.role !== undefined && d.name !== undefined) {
    return page.getByRole(d.role as Parameters<Page["getByRole"]>[0], { name: d.name });
  }
  if (d.label !== undefined) return page.getByLabel(d.label);
  if (d.text !== undefined) return page.getByText(d.text);
  if (d.css !== undefined) return page.locator(d.css);
  throw new Error(`TargetDescriptor has no usable selector: ${JSON.stringify(d)}`);
}

/**
 * True when `locator` resolves to exactly the node `handle` points at.
 *
 * This is the load-bearing correctness check of the whole module, and it is
 * deliberately a DOM-identity comparison rather than a count, a bounding box
 * or an attribute match. Playwright rebuilds `ElementHandle` arguments passed
 * inside an array into the real DOM node references they refer to before
 * invoking the page function, so `a === b` inside the page is `Node === Node`
 * — the only comparison that cannot be fooled by two elements that merely
 * look alike.
 *
 * Returns false (never throws) for an ambiguous locator, a locator that
 * matches nothing, and a handle whose node has been detached: "cannot be
 * proven the same" and "is not the same" are the same answer here.
 */
export async function resolvesToSameElement(
  page: Page,
  locator: Locator,
  handle: ElementHandle<Node>,
  timeoutMs = 1_000,
): Promise<boolean> {
  let count: number;
  try {
    count = await locator.count();
  } catch {
    return false;
  }
  if (count !== 1) return false;

  const resolved = await locator.elementHandle({ timeout: timeoutMs }).catch(() => null);
  if (resolved === null) return false;
  try {
    return await page.evaluate(([a, b]) => a === b, [resolved, handle] as [
      ElementHandle<Node>,
      ElementHandle<Node>,
    ]);
  } catch {
    return false;
  } finally {
    await resolved.dispose().catch(() => undefined);
  }
}

// === Entry point ===

/**
 * Computes the most stable `TargetDescriptor` that provably resolves back to
 * `handle`, and removes the temporary `data-doit-eid` capture attribute.
 *
 * Removal is unconditional and runs in a `finally`: `computeDescriptor` is
 * also called on elements the recorder never tagged, and a no-op
 * `removeAttribute` is harmless — whereas leaving the attribute behind would
 * leak recorder state into the page the user is still using.
 *
 * Throws when no rung validates (a detached node, a closed shadow root, an
 * element with no provable css path). Callers assembling a recording must
 * treat that as "this action is not recordable" rather than guessing.
 */
export async function computeDescriptor(
  page: Page,
  handle: ElementHandle<Node>,
): Promise<ComputedDescriptor> {
  try {
    const facts = await handle.evaluate(readElementFacts, {
      generatedPatterns: [...GENERATED_PATTERNS],
      valueNamedInputTypes: [...VALUE_NAMED_INPUT_TYPES],
    });
    const passing: DescriptorCandidate[] = [];
    for (const candidate of buildCandidates(facts)) {
      const locator = descriptorToLocator(page, candidate.descriptor);
      if (await resolvesToSameElement(page, locator, handle)) passing.push(candidate);
    }

    const primary = passing[0];
    if (primary === undefined) {
      throw new Error(
        `no descriptor uniquely resolves to the acted <${facts.tag}> element (tried: ${
          buildCandidates(facts).map((c) => c.rung).join(", ") || "nothing"
        })`,
      );
    }

    return {
      descriptor: primary.descriptor,
      stability: primary.stability,
      alternates: passing.slice(1).map((c) => c.descriptor),
    };
  } finally {
    await handle
      .evaluate((node, name) => {
        (node as Element).removeAttribute(name);
      }, EID_ATTRIBUTE)
      .catch(() => undefined);
  }
}
