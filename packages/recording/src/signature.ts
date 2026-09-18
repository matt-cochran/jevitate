import type { Assertion, Step, TargetDescriptor } from "./schema.js";

/**
 * Normalizes id-like path segments in a URL (path only — query/hash are left
 * untouched, since they're not addressed by this task) to a fixed `:id`
 * placeholder, so `/thread/1` and `/thread/2` (different takes visiting the
 * "same" semantic page with a different record id) template to the same
 * `/thread/:id`.
 *
 * A path segment is treated as "id-like" when it's one of:
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
 * Pure string transform: no I/O, no randomness.
 */
export function urlTemplate(url: string): string {
  const [pathAndQuery, hash] = splitOnce(url, "#");
  const [path, query] = splitOnce(pathAndQuery, "?");

  const templatedPath = path
    .split("/")
    .map((segment) => (isIdLikeSegment(segment) ? ":id" : segment))
    .join("/");

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

function isIdLikeSegment(segment: string): boolean {
  if (segment.length === 0) return false;
  if (ALL_DIGITS.test(segment)) return true;
  if (UUID.test(segment)) return true;
  if (segment.length >= 8 && LONG_HEX_OR_DASH.test(segment)) return true;
  return false;
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
      return `${assertion.kind}:${targetDescriptorKey(assertion.target)}`;
  }
}

/**
 * Deterministic, value-independent structural key for a `Step` on a given
 * page. Built from `(kind, urlTemplate(pageUrl), structural descriptor)`.
 *
 * Never includes: `TargetDescriptor.name`, `TargetDescriptor.text`, or any
 * step-level captured value/content (a `fill`'s `value`, an `extract`'s
 * `as`, a `forEach`'s `as`, a `handback`'s `prompt`). `press.key` is the
 * exception: for a `press` step the key itself (e.g. `"Enter"`) IS the
 * step's structural identity — there's no separate target/value to key off
 * — so it's used directly, not treated as captured content.
 *
 * Pure: no I/O, no randomness, deterministic for identical inputs.
 */
export function stepSignature(step: Step, pageUrl: string): string {
  const page = urlTemplate(pageUrl);
  const descriptor = structuralKey(step);
  return `${step.kind}|${page}|${descriptor}`;
}

function structuralKey(step: Step): string {
  switch (step.kind) {
    case "navigate":
      return `url:${urlTemplate(step.url)}`;
    case "click":
    case "fill":
    case "select":
    case "waitFor":
    case "extract":
      return targetDescriptorKey(step.target);
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
