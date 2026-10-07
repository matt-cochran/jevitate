/**
 * #399 — `${param}` placeholders in a `navigate.url` (single-use links: invite accept, magic-link
 * sign-in, password reset). A placeholder is resolved from the run's vars like a `fill` value.
 *
 * The safety rules, all enforced here so every runner shares them:
 *  - schema time (`navigateTemplateProblem`): a placeholder is well-formed and sits AFTER the
 *    origin — the scheme, host, port and the path's leading `/` are literal, so no value can
 *    choose where the browser goes;
 *  - run time (`resolveNavigateUrl`): each value is strictly percent-encoded as ONE component
 *    (`/`, `\`, `@`, `?`, `#`, `%`, … can never act as URL syntax), and the resolved URL must keep
 *    the template's origin — otherwise `NavigateUrlParamError`, whose message never holds a value;
 *  - display (`describeNavigateUrl`): a placeholder shows as `<param name>`, never its value.
 */

const PLACEHOLDER = /\$\{([^}]*)\}/g;
const PARAM_NAME = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;
/** The schema's own rule (kept in step with `SAFE_NAVIGATE_URL` in schema.ts). */
const SAFE_NAVIGATE_URL = /^(\/|https?:\/\/)/;
/** An absolute URL whose whole origin is literal and followed by a path/query/fragment delimiter. */
const LITERAL_ORIGIN_PREFIX = /^https?:\/\/[^/?#\\$@]+[/?#]/i;

/** Thrown when a resolved navigate URL would leave its template's origin. Never carries a value. */
/** The longest value a placeholder takes (a token, an id) — longer is refused, never truncated. */
export const MAX_NAVIGATE_PARAM_LENGTH = 4096;

export class NavigateUrlParamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NavigateUrlParamError";
  }
}

/** The placeholder names a navigate URL takes, each once, in order of first use. */
export function navigateUrlParams(url: string): string[] {
  const names: string[] = [];
  for (const m of url.matchAll(PLACEHOLDER)) {
    const name = m[1] ?? "";
    if (!names.includes(name)) names.push(name);
  }
  return names;
}

/**
 * Why a navigate URL template is unsafe or malformed (a message for the schema), or `undefined`.
 * A URL with no `${` at all is always fine here (`SAFE_NAVIGATE_URL` is checked separately).
 */
export function navigateTemplateProblem(url: string): string | undefined {
  const first = url.indexOf("${");
  if (first === -1) return undefined;
  // Every `${` opens a well-formed `${name}`.
  for (let i = first; i !== -1; i = url.indexOf("${", i + 2)) {
    const close = url.indexOf("}", i + 2);
    const name = close === -1 ? undefined : url.slice(i + 2, close);
    if (name === undefined || !PARAM_NAME.test(name)) {
      return "navigate.url has a malformed placeholder — use ${name} with a parameter name (letters, digits, _ . -)";
    }
  }
  const prefix = url.slice(0, first);
  const literalOrigin = prefix.startsWith("/")
    ? !prefix.startsWith("//") && !prefix.startsWith("/\\")
    : LITERAL_ORIGIN_PREFIX.test(prefix);
  if (!literalOrigin) {
    return "navigate.url placeholder must come after the origin — the scheme, host, port and the path's leading '/' must be literal";
  }
  return undefined;
}

/**
 * Percent-encodes a value as one URL component: everything but the RFC 3986 unreserved characters
 * (`A-Z a-z 0-9 - . _ ~`). Stricter than `encodeURIComponent` (it also encodes `!'()*`), so the
 * browser never re-encodes it and the encoded form is the one every sink redacts.
 */
export function encodeUrlParamValue(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** The template for people and models: each placeholder as `<param name>`. */
export function describeNavigateUrl(url: string): string {
  return url.replace(PLACEHOLDER, (_m, name: string) => `<param ${name}>`);
}

const PROBE_BASE = "http://jevitate.invalid";

function originOf(url: string): string | undefined {
  try {
    return new URL(url, PROBE_BASE).origin;
  } catch {
    return undefined;
  }
}

/**
 * The URL to navigate to: each `${name}` replaced by its strictly encoded value from `vars`. An
 * unknown name throws (never navigates with an empty value); a result that would leave the
 * template's origin, or break the schema's URL rule, throws `NavigateUrlParamError`.
 */
export function resolveNavigateUrl(url: string, vars: ReadonlyMap<string, string>): string {
  if (navigateUrlParams(url).length === 0) return url;
  const problem = navigateTemplateProblem(url);
  if (problem !== undefined) throw new NavigateUrlParamError(`${problem} (${describeNavigateUrl(url)})`);
  const resolved = url.replace(PLACEHOLDER, (_m, name: string) => {
    const v = vars.get(name);
    if (v === undefined) throw new Error(`unknown variable: ${name}`);
    if (v.length > MAX_NAVIGATE_PARAM_LENGTH) {
      throw new NavigateUrlParamError(`navigate to ${describeNavigateUrl(url)}: the value of ${name} is longer than ${MAX_NAVIGATE_PARAM_LENGTH} characters — refused`);
    }
    try {
      return encodeUrlParamValue(v);
    } catch {
      throw new NavigateUrlParamError(`navigate to ${describeNavigateUrl(url)}: the value of ${name} is not valid text (a lone surrogate) — refused`);
    }
  });
  const expected = originOf(url.replace(PLACEHOLDER, "x"));
  const relativeEscapes = resolved.startsWith("//") || resolved.startsWith("/\\");
  if (!SAFE_NAVIGATE_URL.test(resolved) || relativeEscapes || expected === undefined || originOf(resolved) !== expected) {
    throw new NavigateUrlParamError(`navigate to ${describeNavigateUrl(url)}: a parameter value would change the URL's origin — refused`);
  }
  return resolved;
}
