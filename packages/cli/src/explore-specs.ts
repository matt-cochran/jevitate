/** The compact `--success`/assertion/descriptor spec parsers and the explore allowlist resolution behind the explore CLI flags. */
import {
  AssertionSchema,
  STYLE_CHANNELS,
  STYLE_PROPERTIES,
  COMPARE_OPS,
  type Assertion,
  type CompareOp,
  type StyleChannel,
  type StyleProperty,
  type TargetDescriptor,
} from "@jevitate/recording";
import { expandBraces, normalizeAllowlist, type StatusSpec, type SuccessCheck } from "@jevitate/explore";

/**
 * Compact assertion spec parser (a recording `Assertion`, checked on a page). Supported forms:
 *   urlIncludes:<text>
 *   visible:<descriptor>
 *   textIncludes:<descriptor>|<text>  — case-insensitive (#113): matches regardless of case, or of a
 *                                        CSS text-transform (a badge whose DOM text is "Approved" but
 *                                        renders `uppercase` still matches `|Approved`)
 *   count:<descriptor>|min=<n>,max=<n>
 *   valueEquals:<descriptor>|<value>   — a form control's VALUE (input, textarea, select), exactly
 * and the visual-state kinds (#148), decided by code from fixed page reads:
 *   style:<descriptor>|<prop><op><value>   — the COMPUTED style of EVERY match (at least one);
 *                                        <prop> is an allowlisted CSS property, optionally one
 *                                        channel of it: alpha(background-color)>0, px(outline-width)>=2;
 *                                        <op> is = != > >= < <= (= compares colors as colors).
 *                                        `styleMatches:` is an alias.
 *   inViewport:<descriptor>[|min=<ratio>] — each match's visible fraction (0..1, default 0.5)
 *   box:<descriptor>|minWidth=<n>,maxWidth=<n>,minHeight=<n>,maxHeight=<n> — each match's size (px)
 *   overlaps:<descriptor>|<descriptor2> / noOverlap:<descriptor>|<descriptor2> — the first matches' boxes
 *   attr:<descriptor>|<name>=<value> | attr:<descriptor>|<name> (present) | attr:<descriptor>|!<name> (absent)
 *   flashed:<descriptor>|class=<cls>|attr=<name>|animation [|withinMs=<n>] — a match GAINED the
 *                                        class / attribute / an animation after the last user input
 * where <descriptor> is `k=v` pairs joined by `;` over testId/role/name/label/text/css
 * (`css=h1`, `label=Display name`, `role=button;name=Save`) — key=value always wins, so a `=` is
 * never read as CSS or text. With no `=` at all, a descriptor starting with `[`, `#` or `.` is CSS
 * verbatim (`[data-testid=x]` becomes `testId=x`); any OTHER bare descriptor is read as CSS too, but
 * only when it is a lowercase-only, syntactically valid CSS selector (#213: `h1`, `main h1`, `body`,
 * `div.card`, `ul > li` — tag names, combinators, classes, ids, attributes, pseudo-classes; every
 * character lowercase is what tells a real selector apart from an accessible-name phrase like
 * `Display name`, which is never guessed at as either CSS or text). Anything that is not a valid
 * key=value spec and not a lowercase CSS selector is refused with a hint naming the key=value forms
 * (`css=`, `label=`, `testId=`, `role=`, `text=`) and an example. In `textIncludes` / `valueEquals`
 * the LAST `|` separates the descriptor from the text.
 */
export function parseAssertionSpec(spec: string): Assertion {
  const ci = spec.indexOf(":");
  if (ci === -1) throw new Error(`invalid --success spec ${JSON.stringify(spec)}; expected "<kind>:<...>"`);
  const kind = spec.slice(0, ci);
  const rest = spec.slice(ci + 1);

  switch (kind) {
    case "urlIncludes": {
      if (rest === "") throw new Error("urlIncludes requires a text (urlIncludes:/path)");
      return { kind: "urlIncludes", text: rest };
    }
    case "visible":
      return { kind: "visible", target: parseDescriptorSpec(rest) };
    case "textIncludes": {
      const bar = rest.lastIndexOf("|");
      if (bar === -1) throw new Error('textIncludes requires "<descriptor>|<text>"');
      return { kind: "textIncludes", target: parseDescriptorSpec(rest.slice(0, bar)), text: rest.slice(bar + 1) };
    }
    case "valueEquals": {
      const bar = rest.lastIndexOf("|");
      if (bar === -1) throw new Error('valueEquals requires "<descriptor>|<value>"');
      return { kind: "valueEquals", target: parseDescriptorSpec(rest.slice(0, bar)), value: rest.slice(bar + 1) };
    }
    case "count": {
      const bar = rest.indexOf("|");
      const descPart = bar === -1 ? rest : rest.slice(0, bar);
      const bounds = bar === -1 ? "" : rest.slice(bar + 1);
      const target = parseDescriptorSpec(descPart);
      const out: Assertion = { kind: "count", target };
      for (const pair of bounds.split(",")) {
        const [k, v] = pair.split("=");
        if (k === "min" && v) (out as { min?: number }).min = Number(v);
        if (k === "max" && v) (out as { max?: number }).max = Number(v);
      }
      return out;
    }
    case "style":
    case "styleMatches":
    case "inViewport":
    case "box":
    case "overlaps":
    case "noOverlap":
    case "attr":
    case "flashed":
      return parseVisualSpec(kind, rest);
    default:
      throw new Error(`unsupported assertion kind ${JSON.stringify(kind)}`);
  }
}

/** A finite number from a spec, or a precise error. */
function specNumber(kind: string, key: string, v: string | undefined): number {
  const n = v === undefined || v.trim() === "" ? Number.NaN : Number(v);
  if (!Number.isFinite(n)) throw new Error(`${kind}: ${key} must be a number, got ${JSON.stringify(v ?? "")}`);
  return n;
}

/** `<descriptor>|<rest>` split at the FIRST `|`; `rest` required unless `optional`. */
function splitDescriptor(kind: string, spec: string, shape: string, optional = false): [TargetDescriptor, string] {
  const bar = spec.indexOf("|");
  if (bar === -1 && !optional) throw new Error(`${kind} requires "${shape}"`);
  return [parseDescriptorSpec(bar === -1 ? spec : spec.slice(0, bar)), bar === -1 ? "" : spec.slice(bar + 1)];
}

/**
 * The visual-state assertion specs (#148) — see `parseAssertionSpec`. Validated through the
 * recording `AssertionSchema` (the allowlisted properties, a closed set of ops/channels), so a typo
 * fails here, before any browser work.
 */
/** `<prop><op><value>` / `<channel>(<prop>)<op><value>` — ops from the shared `COMPARE_OPS` (longest first). */
const STYLE_CHECK_RE = new RegExp(
  String.raw`^\s*(?:([a-z]+)\(\s*([a-z-]+)\s*\)|([a-z-]+))\s*(${COMPARE_OPS.join("|")})\s*(.*)$`,
);

function parseVisualSpec(kind: string, rest: string): Assertion {
  let out: Assertion;
  switch (kind) {
    case "style":
    case "styleMatches": {
      // The descriptor ends at the LAST `|` (a style value never contains one).
      const bar = rest.lastIndexOf("|");
      if (bar === -1) throw new Error(`${kind} requires "<descriptor>|<prop><op><value>", e.g. ${kind}:[data-heat]|alpha(background-color)>0`);
      const target = parseDescriptorSpec(rest.slice(0, bar));
      const m = STYLE_CHECK_RE.exec(rest.slice(bar + 1));
      if (m === null) throw new Error(`${kind}: expected <prop><op><value> (op = != > >= < <=), got ${JSON.stringify(rest.slice(bar + 1))}`);
      const channel = m[1];
      const property = m[2] ?? m[3] ?? "";
      if (channel !== undefined && !(STYLE_CHANNELS as readonly string[]).includes(channel)) {
        throw new Error(`${kind}: unknown channel ${JSON.stringify(channel)} (one of ${STYLE_CHANNELS.join(", ")})`);
      }
      if (!(STYLE_PROPERTIES as readonly string[]).includes(property)) {
        throw new Error(`${kind}: property ${JSON.stringify(property)} is not allowlisted (one of ${STYLE_PROPERTIES.join(", ")})`);
      }
      out = {
        kind: "style",
        target,
        property: property as StyleProperty,
        ...(channel === undefined ? {} : { channel: channel as StyleChannel }),
        op: m[4] as CompareOp,
        value: (m[5] ?? "").trim(),
      };
      break;
    }
    case "inViewport": {
      const [target, opts] = splitDescriptor(kind, rest, "<descriptor>[|min=<ratio>]", true);
      out = { kind: "inViewport", target };
      for (const pair of opts.split(",").filter((p) => p !== "")) {
        const [k, v] = pair.split("=");
        if (k !== "min") throw new Error(`inViewport: unknown option ${JSON.stringify(k)} (only min=<ratio>)`);
        out = { ...out, min: specNumber(kind, "min", v) };
      }
      break;
    }
    case "box": {
      const [target, opts] = splitDescriptor(kind, rest, "<descriptor>|minWidth=<n>,maxWidth=<n>,minHeight=<n>,maxHeight=<n>");
      const bounds: Record<string, number> = {};
      for (const pair of opts.split(",").filter((p) => p !== "")) {
        const [k, v] = pair.split("=");
        if (k !== "minWidth" && k !== "maxWidth" && k !== "minHeight" && k !== "maxHeight") {
          throw new Error(`box: unknown bound ${JSON.stringify(k)} (minWidth, maxWidth, minHeight, maxHeight)`);
        }
        bounds[k] = specNumber(kind, k, v);
      }
      if (Object.keys(bounds).length === 0) throw new Error("box needs at least one bound");
      out = { kind: "box", target, ...bounds };
      break;
    }
    case "overlaps":
    case "noOverlap": {
      const [target, other] = splitDescriptor(kind, rest, "<descriptor>|<descriptor2>");
      out = { kind: "overlap", target, other: parseDescriptorSpec(other), overlapping: kind === "overlaps" };
      break;
    }
    case "attr": {
      const [target, spec] = splitDescriptor(kind, rest, "<descriptor>|<name>[=<value>] or <descriptor>|!<name>");
      if (spec.startsWith("!")) out = { kind: "attr", target, name: spec.slice(1), absent: true };
      else {
        const eq = spec.indexOf("=");
        out = eq === -1 ? { kind: "attr", target, name: spec } : { kind: "attr", target, name: spec.slice(0, eq), value: spec.slice(eq + 1) };
      }
      break;
    }
    case "flashed": {
      const [target, opts] = splitDescriptor(kind, rest, "<descriptor>|class=<cls> (or attr=<name>, animation)[|withinMs=<n>]");
      let f: Extract<Assertion, { kind: "flashed" }> = { kind: "flashed", target };
      for (const part of opts.split("|").filter((p) => p !== "")) {
        const eq = part.indexOf("=");
        const k = eq === -1 ? part : part.slice(0, eq);
        const v = eq === -1 ? "" : part.slice(eq + 1);
        if (k === "class") f = { ...f, className: v };
        else if (k === "attr") f = { ...f, attr: v };
        else if (k === "animation" && eq === -1) f = { ...f, animation: true };
        else if (k === "withinMs") f = { ...f, withinMs: specNumber(kind, "withinMs", v) };
        else throw new Error(`flashed: unknown option ${JSON.stringify(part)} (class=<cls>, attr=<name>, animation, withinMs=<n>)`);
      }
      out = f;
      break;
    }
    default:
      throw new Error(`unsupported assertion kind ${JSON.stringify(kind)}`);
  }
  const parsed = AssertionSchema.safeParse(out);
  if (!parsed.success) {
    throw new Error(`invalid ${kind} spec: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
  }
  return parsed.data;
}

const HTTP_METHOD = /^(?:[A-Za-z]+|\*)$/;

/**
 * `<METHOD> <path-glob>` — the request half of a network check. Two distinct
 * failure modes get two distinct messages: a missing/malformed method (or no
 * space at all) doesn't match the shape at all, while a present-but-unrooted
 * path glob is the far more common mistake (issue #83) and deserves to say
 * exactly what's wrong instead of re-printing the whole shape as if nothing
 * was recognized.
 */
function parseRequestSpec(kind: string, text: string): { method: string; pathGlob: string } {
  const sp = text.indexOf(" ");
  const method = sp === -1 ? "" : text.slice(0, sp);
  const pathGlob = sp === -1 ? "" : text.slice(sp + 1).trim();
  if (!HTTP_METHOD.test(method) || pathGlob.length === 0) {
    throw new Error(`${kind} requires "<METHOD> <path-glob>", e.g. ${kind}:PUT /api/profile/*`);
  }
  if (!pathGlob.startsWith("/")) {
    throw new Error(`${kind}: path glob must start with "/" (got ${JSON.stringify(pathGlob)})`);
  }
  // #325: `{a,b}` alternation — every alternative must be rooted too, and the expansion bounded.
  for (const alt of expandBraces(pathGlob)) {
    if (!alt.startsWith("/")) throw new Error(`${kind}: every {a,b} alternative of the path glob must start with "/" (got ${JSON.stringify(alt)})`);
  }
  return { method: method.toUpperCase(), pathGlob };
}

function parseStatusSpec(text: string): StatusSpec {
  if (/^[1-5]xx$/i.test(text)) return { class: Number(text[0]) as 1 | 2 | 3 | 4 | 5 };
  if (/^[1-5]\d\d$/.test(text)) return { code: Number(text) };
  throw new Error(`responseStatus expects 2xx, 4xx … or a status code, got ${JSON.stringify(text)}`);
}

/**
 * The goal mission's `--success` spec parser (repeatable: every check must hold). Besides every
 * page assertion `parseAssertionSpec` reads:
 *   reloadThen:<assertion>                     — reload the page, then check (persistence)
 *   requestMade:<METHOD> <path-glob>           — the run issued this request
 *   responseStatus:<METHOD> <path-glob>=<2xx|4xx|code> — and it got this status
 * `<path-glob>` uses the route-glob syntax (`*` within a segment, `**` across segments) against
 * the request's path; `*` as METHOD matches any method.
 */
export function parseSuccessSpec(spec: string): SuccessCheck {
  const ci = spec.indexOf(":");
  const kind = ci === -1 ? spec : spec.slice(0, ci);
  const rest = ci === -1 ? "" : spec.slice(ci + 1);
  switch (kind) {
    case "reloadThen":
      if (rest.startsWith("reloadThen:")) throw new Error("reloadThen cannot be nested");
      return { kind: "reloadThen", assertion: parseAssertionSpec(rest) };
    case "requestMade":
      return { kind: "requestMade", ...parseRequestSpec(kind, rest) };
    case "responseStatus": {
      const eq = rest.lastIndexOf("=");
      if (eq === -1) throw new Error('responseStatus requires "<METHOD> <path-glob>=<2xx|4xx|code>"');
      return { kind: "responseStatus", ...parseRequestSpec(kind, rest.slice(0, eq)), status: parseStatusSpec(rest.slice(eq + 1)) };
    }
    default:
      return { kind: "page", assertion: parseAssertionSpec(spec) };
  }
}

function parseDescriptorSpec(s: string): TargetDescriptor {
  const raw = s.trim();
  if (/^[[#.]/.test(raw)) {
    // A CSS selector. The common test-id attribute form becomes a test-id descriptor (the most
    // stable rung); anything else is used as CSS verbatim.
    const testId = /^\[data-testid=(?:"([^"]*)"|'([^']*)'|([^\]"']*))\]$/.exec(raw);
    const id = testId === null ? undefined : (testId[1] ?? testId[2] ?? testId[3]);
    if (id !== undefined && id !== "") return { testId: id };
    return { css: raw };
  }
  const d: TargetDescriptor = {};
  const keys = ["testId", "role", "name", "label", "text", "css"] as const;
  for (const pair of s.split(";")) {
    const eq = pair.indexOf("=");
    if (eq === -1) continue;
    const k = pair.slice(0, eq);
    const v = pair.slice(eq + 1);
    if ((keys as readonly string[]).includes(k) && v !== "") {
      (d as Record<string, string>)[k] = v;
    } else if (k === "textContains" && v !== "") {
      // #335: `text=` matches an element's WHOLE text exactly; `textContains=` a substring.
      d.text = v;
      d.textMatch = "contains";
    }
  }
  if (d.testId || d.role || d.label || d.text || d.css) return d;
  // #213: no key=value pair matched — a bare, lowercase, syntactically valid CSS selector (a tag
  // name or a combination of them) is read as CSS; anything else is refused with a hint, never a
  // silent guess between CSS and text.
  if (looksLikeBareCssSelector(raw)) return { css: raw };
  throw new Error(`descriptor spec ${JSON.stringify(s)} has no usable selector — ${DESCRIPTOR_HINT}`);
}

/**
 * The authorized-origins allowlist for a run: explicit `--allow` origins when
 * given, otherwise the target URL's own origin (you asked to explore it). An
 * unparseable URL yields an empty allowlist → the guard fails closed.
 */
export function resolveExploreAllowlist(url: string, allow: readonly string[]): string[] {
  if (allow.length > 0) return [...allow];
  return normalizeAllowlist([url]);
}

/**
 * A conservative CSS-selector grammar check for a BARE (no `=`, no leading `[`/`#`/`.`) `--success`
 * descriptor (#213). It deliberately does not implement the full CSS grammar — its only job is to
 * tell a genuine selector (`h1`, `main h1`, `body`, `div.card`, `ul > li`) apart from a plain
 * accessible-name phrase (`Display name`). HTML tag names, classes, ids and pseudo-classes are
 * conventionally lowercase; requiring the WHOLE string to be lowercase is the disambiguator — a
 * descriptor with any uppercase letter is never read as CSS, no matter its shape.
 */
const CSS_IDENT = "[a-z][a-z0-9-]*";

const CSS_ATTR = `\\[${CSS_IDENT}(?:[~^$*|]?=(?:"[^"]*"|'[^']*'|${CSS_IDENT}))?\\]`;

const CSS_PSEUDO = `::?${CSS_IDENT}(?:\\([^()]*\\))?`;

const CSS_QUALIFIER = `(?:\\.${CSS_IDENT}|#${CSS_IDENT}|${CSS_ATTR}|${CSS_PSEUDO})`;

const CSS_COMPOUND = `(?:(?:\\*|${CSS_IDENT})${CSS_QUALIFIER}*|${CSS_QUALIFIER}+)`;

const BARE_CSS_SELECTOR_RE = new RegExp(`^${CSS_COMPOUND}(?:(?:\\s*[>+~]\\s*|\\s+)${CSS_COMPOUND})*$`);

function looksLikeBareCssSelector(raw: string): boolean {
  return raw !== "" && !/[^\x20-\x7e]/.test(raw) && !/[A-Z]/.test(raw) && BARE_CSS_SELECTOR_RE.test(raw);
}

const DESCRIPTOR_HINT =
  'use css=<selector>, label=<text>, testId=<id>, role=<role>;name=<name>, text=<whole text> or textContains=<part of the text> (e.g. "css=h1" or "label=Display name")';
