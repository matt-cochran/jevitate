/**
 * Authenticates a probe from the run's own session (#135) — never a new credential path. Exactly one
 * source:
 *  - `localStorage` — a key read from the live page's `localStorage` (via `page.evaluate`);
 *  - `cookie`       — a named cookie's value, read from the browser context;
 *  - `secret`       — a `--secret`/env reference (`env:VAR`), resolved by the CLI dispatch — never
 *                      read from a file here.
 * The value becomes the probe's `Authorization` header, prefixed by `scheme` (default `Bearer`; `""`
 * sends the raw value with no prefix). The token itself never reaches the model, is never persisted,
 * and is redacted from every evidence line the same way a bound secret is.
 */
export interface ProbeAuthFrom {
  localStorage?: string;
  cookie?: string;
  secret?: string;
  /** Prefixed onto the Authorization header's value. Default `"Bearer"`; `""` = no prefix. */
  scheme?: string;
}

export interface ProbeObservable {
  /** A read-only GET of this path (resolved against the mission's start URL) or absolute URL. */
  get?: string;
  /** A read-only HEAD (its value is the HTTP status). Exactly one of `get` / `head`. */
  head?: string;
  /** JSON path into a GET's body; without it the value is the HTTP status. */
  json?: string;
  optional?: boolean;
  /** Authenticates the probe from the run's session (#135); see `ProbeAuthFrom`. */
  authFrom?: ProbeAuthFrom;
  /**
   * #147: read in this OBSERVER actor's own browser context (its own cookies), never the primary's.
   * Only a capture-gated invariant (`when.after: "capture.<name>"`) may read such an observable.
   */
  as?: string;
}

/** `authFrom.secret`'s only accepted shape (#135): the same `env:VAR` reference `--secret-field` uses. */
export const AUTH_SECRET_REF_RE = /^env:[A-Za-z_][A-Za-z0-9_]*$/;

/** The origin a probe's URL resolves to (relative paths against `baseUrl`), or null when unparseable. */
export function probeUrl(probe: ProbeObservable, baseUrl: string): URL | null {
  const raw = probe.get ?? probe.head;
  if (raw === undefined) return null;
  return resolveHttpUrl(raw, baseUrl);
}

/** An http(s) URL (relative paths against `baseUrl`), or null. */
export function resolveHttpUrl(raw: string, baseUrl: string): URL | null {
  try {
    const u = new URL(raw, baseUrl);
    return u.protocol === "http:" || u.protocol === "https:" ? u : null;
  } catch {
    return null;
  }
}
