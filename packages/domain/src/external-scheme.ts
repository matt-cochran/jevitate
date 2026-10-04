/**
 * #375: a URL whose scheme the browser does not load itself but hands to the OS / another app —
 * `sms:`, `tel:`, `mailto:`, `facetime:`, `maps:`, `intent:`, an app deep link (`myapp://…`).
 * Headless Chromium has no handler for these, so a click on such a link is reported as
 * `requestfailed: net::ERR_ABORTED` for a navigation that never reached the network. That is not
 * a failed request of the system under test, never a defect.
 *
 * The rule is an allowlist of the schemes the browser DOES fetch or render itself: anything else
 * is external. `http:`/`https:` (and `ws:`/`wss:`) are network schemes; `data:`, `blob:`,
 * `about:`, `file:`, `javascript:` and the browser's own internal schemes are handled in-browser —
 * a failure there is the page's own, so none of them is ever classed as external. A string that is
 * not an absolute URL (no parseable scheme) is never external either (fail closed: it stays a
 * failure).
 */
const IN_BROWSER_SCHEMES: ReadonlySet<string> = new Set([
  "http",
  "https",
  "ws",
  "wss",
  "data",
  "blob",
  "about",
  "file",
  "javascript",
  "filesystem",
  "chrome",
  "chrome-extension",
  "chrome-error",
  "chrome-untrusted",
  "devtools",
  "edge",
  "view-source",
  "moz-extension",
  "resource",
]);

/** RFC 3986 scheme: a letter, then letters/digits/`+`/`-`/`.`, then `:`. */
const SCHEME = /^([a-z][a-z0-9+.-]*):/i;

/** The URL's scheme, lowercased and without the colon (`"sms"`), or undefined when it has none. */
export function urlSchemeOf(url: string): string | undefined {
  const m = SCHEME.exec(url.trim());
  return m?.[1]?.toLowerCase();
}

/**
 * The external (OS-handled) scheme of `url` — `"sms"`, `"tel"`, `"mailto"`, … — or undefined when
 * the browser loads the URL itself (http(s), data, blob, about, …) or it has no scheme.
 */
export function externalSchemeOf(url: string): string | undefined {
  const scheme = urlSchemeOf(url);
  if (scheme === undefined || IN_BROWSER_SCHEMES.has(scheme)) return undefined;
  return scheme;
}

/** Whether `url` is handed to the OS / another app rather than loaded by the browser (#375). */
export function isExternalSchemeUrl(url: string): boolean {
  return externalSchemeOf(url) !== undefined;
}
