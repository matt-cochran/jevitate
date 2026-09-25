import type { Assertion, Step, TargetDescriptor } from "./schema.js";

/**
 * Normalizes id-like path segments in a URL (path only — query/hash are left
 * untouched, since they're not addressed by this task) to a fixed `:id`
 * placeholder, so `/thread/1` and `/thread/2` (different takes visiting the
 * "same" semantic page with a different record id) template to the same
 * `/thread/:id`.
 *
 * A whole path segment is treated as "id-like" when it's one of:
 *  - all digits (`/^[0-9]+$/`) — e.g. `1`, `42`
 *  - a standard UUID (8-4-4-4-12 hex, case-insensitive)
 *  - a long (length >= 8) token composed only of hex digits and/or dashes —
 *    this catches other generated-looking ids (hashes, ULID-ish tokens,
 *    Mongo ObjectIds, etc.) without also catching an ordinary fixed route
 *    word: real route words are virtually never 8+ chars of *only*
 *    `[0-9a-f-]`, since that excludes every letter g-z. This is a heuristic,
 *    not a guarantee — a route word that happens to be a long lowercase hex
 *    run (unlikely in practice) would be mis-templated.
 *
 * A segment that ISN'T id-like as a whole is also checked for a PREFIXED id —
 * a literal route word followed by `-` and an id-like suffix (#95), e.g.
 * `candidate-a1b2c3d4-e5f6-4a3b-8c1d-ef1234567890` or `item-42`: the WHOLE
 * segment templates (#127) — a literal prefix is never kept, so
 * `/decisions/candidate-<uuid>` and `/decisions/demo-bet-1` both become
 * `/decisions/:id` (one route), whatever shape the id suffix happens to be. So is a short word
 * joined by `.`/`_`/`:` to a long hex id (#188): `/workbench/ws.1697a048f9bc…` → `/workbench/:id`.
 *
 * Pure string transform: no I/O, no randomness.
 */
export function urlTemplate(url: string): string {
  const [pathAndQuery, hash] = splitOnce(url, "#");
  const [path, query] = splitOnce(pathAndQuery, "?");

  const templatedPath = path.split("/").map(templateSegment).join("/");

  return templatedPath + (query !== undefined ? `?${query}` : "") + (hash !== undefined ? `#${hash}` : "");
}

function splitOnce(input: string, separator: string): [string, string | undefined] {
  const index = input.indexOf(separator);
  if (index === -1) return [input, undefined];
  return [input.slice(0, index), input.slice(index + separator.length)];
}

const ALL_DIGITS = /^[0-9]+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LONG_HEX_OR_DASH = /^[0-9a-f-]+$/i;

/** A literal prefix followed by `-` and a UUID suffix — checked BEFORE `PREFIXED_ID_SUFFIX` so a
 *  uuid's own internal dashes are never split at the wrong one. Templates the WHOLE segment (#127):
 *  a literal prefix is never kept. */
const PREFIXED_UUID = /^(.+-)([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
/** A literal prefix followed by `-` and an all-digits or long hex/dash id suffix — e.g. `demo-bet-1`
 *  (#127); the WHOLE segment templates, same as `PREFIXED_UUID`. */
const PREFIXED_ID_SUFFIX = /^(.+-)([0-9]+|[0-9a-f-]{8,})$/i;
/** A short word prefix joined by `.` / `_` / `:` to a long hex id — e.g. `ws.1697a048f9bc…` (#188).
 *  Only a long hex suffix (8+) counts, so a file name (`index.html`, `v1.2`) never templates. */
const DOTTED_HEX_ID = /^[a-z][a-z0-9]{0,15}[._:][0-9a-f]{8,}$/i;

function isIdLikeSegment(segment: string): boolean {
  if (segment.length === 0) return false;
  if (ALL_DIGITS.test(segment)) return true;
  if (UUID.test(segment)) return true;
  if (segment.length >= 8 && LONG_HEX_OR_DASH.test(segment)) return true;
  if (PREFIXED_UUID.test(segment)) return true;
  if (PREFIXED_ID_SUFFIX.test(segment)) return true;
  if (DOTTED_HEX_ID.test(segment)) return true;
  return false;
}

/** Templates one path segment: an id-like segment (whole, or a literal prefix plus an id-like
 *  suffix, #127) → `:id`, matched anywhere — never a partial `prefix-:id`; else unchanged. */
function templateSegment(segment: string): string {
  return isIdLikeSegment(segment) ? ":id" : segment;
}

/**
 * Builds a structural descriptor key from a `TargetDescriptor`, deliberately
 * EXCLUDING `name` and `text` — those carry the concrete/enumerated content
 * a later task (column classification) needs to read from the untouched
 * step, and folding them in here would defeat trace alignment across takes
 * with different typed/clicked content.
 *
 * Ladder: testId > role > label > css > "no identifying field" marker.
 * `css` is included (unlike `name`/`text`) because a CSS selector is itself
 * a structural anchor, not a captured value.
 */
function targetDescriptorKey(target: TargetDescriptor | undefined): string {
  if (!target) return "notarget";
  if (target.testId) return `testId:${target.testId}`;
  if (target.role) return `role:${target.role}`;
  if (target.label) return `label:${target.label}`;
  if (target.css) return `css:${target.css}`;
  return "noident";
}

/**
 * Structural key for an `Assertion`, reusing `targetDescriptorKey` on its
 * `target` where present. `urlIncludes` has no target, only a `text` url
 * fragment — that text IS structurally the url being asserted on, so it's
 * templated (not a captured/typed value) and folded in via `urlTemplate`.
 */
function assertionKey(assertion: Assertion): string {
  switch (assertion.kind) {
    case "urlIncludes":
      return `urlIncludes:${urlTemplate(assertion.text)}`;
    case "visible":
    case "textIncludes":
    case "count":
    case "valueEquals":
    case "inViewport":
    case "box":
    case "attr":
    case "flashed":
      return `${assertion.kind}:${targetDescriptorKey(assertion.target)}`;
    case "style":
      // Which property is checked is authored/structural; the compared value is not.
      return `style:${targetDescriptorKey(assertion.target)}|${assertion.property}`;
    case "overlap":
      return `overlap:${targetDescriptorKey(assertion.target)}|${targetDescriptorKey(assertion.other)}`;
  }
}

/**
 * Deterministic, value-independent structural key for a `Step` on a given
 * page. Built from `(kind, urlTemplate(pageUrl), structural descriptor)`.
 *
 * Never includes: `TargetDescriptor.name`, `TargetDescriptor.text`, or any
 * step-level captured value/content (a `fill`'s or `select`'s `value`, an
 * `extract`'s `as`, a `forEach`'s `as`, a `handback`'s `prompt`, an
 * `assert`/`handback`'s nested `Assertion.text` on `textIncludes`).
 * `press.key`, `waitFor.state`, and `extract.attr` are the exceptions: they
 * are authored/structural fields (what to press, which state to wait for,
 * which attribute to read), not captured/typed content, so they're folded
 * directly into the key.
 *
 * Pure: no I/O, no randomness, deterministic for identical inputs.
 */
export function stepSignature(step: Step, pageUrl: string): string {
  const page = urlTemplate(pageUrl);
  const descriptor = structuralKey(step);
  return `${step.kind}|${page}|${descriptor}`;
}

/**
 * Deterministic key that ALSO folds in the fields `stepSignature` deliberately
 * excludes: `TargetDescriptor.name`/`.text` (the accessible name/text of the
 * acted element) and `.ordinal` (which same-named sibling was acted on).
 *
 * Used for **divergence detection** (`diffRecordings`), never for alignment:
 * alignment must stay value/name-independent (that's `stepSignature`'s job,
 * unchanged), or a run that clicked the WRONG same-role control would never
 * even align against the reference step it should be compared to. Once two
 * steps are aligned by `stepSignature`, comparing their `strictSignature`
 * tells you whether they're truly the same control or a structurally-
 * identical-but-different one (e.g. two same-role buttons with different
 * accessible names, or the 2nd vs. 3rd same-role/same-name sibling).
 *
 * Built as `stepSignature | strictKey`, so anything `stepSignature` already
 * distinguishes stays distinguished here too — this is strictly more
 * specific than `stepSignature`, never less.
 *
 * Pure: no I/O, no randomness, deterministic for identical inputs.
 */
export function strictSignature(step: Step, pageUrl: string): string {
  return `${stepSignature(step, pageUrl)}|${strictKey(step)}`;
}

/**
 * The name/text/ordinal suffix folded on top of `structuralKey` to produce
 * `strictSignature`. Only ever adds identifying detail for the step kinds
 * that carry a `TargetDescriptor` (directly, or via `items`/an `Assertion`'s
 * `target`) — `navigate` and `press` have none, so they contribute nothing
 * beyond what `stepSignature` already captures.
 */
function strictKey(step: Step): string {
  switch (step.kind) {
    case "navigate":
    case "press":
      return "";
    case "click":
    case "fill":
    case "select":
    case "upload":
    case "editText":
    case "waitFor":
    case "extract":
      return targetDescriptorStrictKey(step.target);
    case "forEach":
      return targetDescriptorStrictKey(step.items);
    case "assert":
      return assertionStrictKey(step.check);
    case "handback":
      return assertionStrictKey(step.resume);
  }
}

/**
 * The `name`/`text`/`ordinal` portion of a `TargetDescriptor`, deliberately
 * left OUT of `targetDescriptorKey` (structural) and folded in here instead.
 * `?? ""` distinguishes "field omitted" from "field present but empty" so
 * they never collide with each other.
 */
function targetDescriptorStrictKey(target: TargetDescriptor | undefined): string {
  if (!target) return "";
  return `name:${target.name ?? ""}|text:${target.text ?? ""}|ordinal:${target.ordinal ?? ""}`;
}

/** Strict counterpart to `assertionKey`, reusing `targetDescriptorStrictKey` on its `target` where present. */
function assertionStrictKey(assertion: Assertion): string {
  switch (assertion.kind) {
    case "urlIncludes":
      return "";
    case "visible":
    case "textIncludes":
    case "count":
    case "valueEquals":
    case "style":
    case "inViewport":
    case "box":
    case "overlap":
    case "attr":
    case "flashed":
      return targetDescriptorStrictKey(assertion.target);
  }
}

function structuralKey(step: Step): string {
  switch (step.kind) {
    case "navigate":
      return `url:${urlTemplate(step.url)}`;
    case "click":
    case "fill":
    case "select":
    case "upload":
      return targetDescriptorKey(step.target);
    case "waitFor":
      // `state` is an authored/structural field (like `press.key`), not
      // captured content — a waitFor for "visible" vs "hidden" on the same
      // target is a structurally different step, so it belongs in the key.
      return `${targetDescriptorKey(step.target)}|state:${step.state}`;
    case "extract":
      // `attr` is likewise structural (which attribute to read is authored,
      // not typed/captured) — unlike `as` (the captured variable name),
      // which must stay OUT of the key. `?? ""` distinguishes "omitted"
      // from a present-but-different value so they never collide.
      return `${targetDescriptorKey(step.target)}|attr:${step.attr ?? ""}`;
    case "editText":
      // The action is authored/structural; the anchor quote and the typed value are content.
      return `${targetDescriptorKey(step.target)}|action:${step.action}`;
    case "forEach":
      return targetDescriptorKey(step.items);
    case "press":
      return `key:${step.key}`;
    case "assert":
      return assertionKey(step.check);
    case "handback":
      return assertionKey(step.resume);
  }
}
