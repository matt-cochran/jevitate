import { readFileSync } from "node:fs";

/**
 * Session-derived request auth for code-issued HTTP calls (mission fixtures, #140/#144) — the
 * "#135-style" helper: authenticate a request exactly as the app's own page would, from the run's
 * `--storage-state` (a bearer token the SPA keeps in localStorage, or the session cookies) or from a
 * `--secret-field` binding. No browser is needed: the storageState JSON already holds what the page
 * would read.
 *
 * Every value this module returns is a credential. Callers put it on the wire and NOWHERE else — it
 * never reaches a model, a log line or an artifact (fixture step logs never include request headers).
 *
 * NOTE (coordination): #135 (authenticated invariant probes) needs the same thing; if it lands its
 * own helper, fold one into the other.
 */

export type RequestAuth =
  /** `<header>: <scheme> <localStorage[key]>` for the request's origin (default `Authorization: Bearer`). */
  | { readonly from: "localStorage"; readonly key: string; readonly scheme?: string; readonly header?: string }
  /** The storageState cookies that match the request URL, as a `Cookie` header. */
  | { readonly from: "cookies" }
  /** `<header>: <scheme> <value>` from a `--secret-field` binding, named by its env variable. */
  | { readonly from: "secretField"; readonly name: string; readonly scheme?: string; readonly header?: string };

export interface AuthSources {
  /** Path of the run's Playwright storageState JSON (`--storage-state`). */
  readonly storageStatePath?: string;
  /** `--secret-field` values by their env-variable name. */
  readonly secretFields?: Readonly<Record<string, string>>;
}

export class FixtureAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FixtureAuthError";
  }
}

interface StoredCookie {
  readonly name: string;
  readonly value: string;
  readonly domain: string;
  readonly path?: string;
  readonly expires?: number;
  readonly secure?: boolean;
}

interface StorageState {
  readonly cookies: StoredCookie[];
  readonly origins: { readonly origin: string; readonly localStorage: { name: string; value: string }[] }[];
}

function readStorageState(path: string): StorageState {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    // The message names the file only: its contents are credentials.
    throw new FixtureAuthError(`cannot read storage state ${path}: ${e instanceof SyntaxError ? "not valid JSON" : "unreadable"}`);
  }
  const o = (raw ?? {}) as Record<string, unknown>;
  const cookies = Array.isArray(o.cookies) ? (o.cookies as StoredCookie[]).filter((c) => typeof c?.name === "string" && typeof c.value === "string" && typeof c.domain === "string") : [];
  const origins = Array.isArray(o.origins)
    ? (o.origins as StorageState["origins"]).filter((x) => typeof x?.origin === "string" && Array.isArray(x.localStorage))
    : [];
  return { cookies, origins };
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

function cookieMatches(c: StoredCookie, url: URL, nowSec: number): boolean {
  const domain = c.domain.startsWith(".") ? c.domain.slice(1) : c.domain;
  const host = url.hostname;
  if (host !== domain && !(c.domain.startsWith(".") && host.endsWith(`.${domain}`))) return false;
  const path = c.path ?? "/";
  if (!url.pathname.startsWith(path)) return false;
  if (c.secure === true && url.protocol !== "https:" && !LOOPBACK.has(host)) return false;
  if (typeof c.expires === "number" && c.expires > 0 && c.expires < nowSec) return false;
  return true;
}

function withScheme(scheme: string | undefined, value: string, fallback: string): string {
  const s = scheme ?? fallback;
  return s === "" ? value : `${s} ${value}`;
}

/**
 * The header(s) `auth` adds to a request to `url`. Throws `FixtureAuthError` (naming the source,
 * never a value) when the source is missing — a fixture never silently runs unauthenticated.
 */
export function authHeaders(auth: RequestAuth, url: string, sources: AuthSources): Record<string, string> {
  const target = new URL(url);
  if (auth.from === "secretField") {
    const value = sources.secretFields?.[auth.name];
    if (value === undefined || value === "") {
      throw new FixtureAuthError(`auth needs the --secret-field bound to env:${auth.name}, which this run does not have`);
    }
    return { [auth.header ?? "authorization"]: withScheme(auth.scheme, value, "Bearer") };
  }
  if (sources.storageStatePath === undefined) {
    throw new FixtureAuthError(`auth from ${auth.from} needs --storage-state`);
  }
  const state = readStorageState(sources.storageStatePath);
  if (auth.from === "cookies") {
    const nowSec = Date.now() / 1000;
    const jar = state.cookies.filter((c) => cookieMatches(c, target, nowSec));
    if (jar.length === 0) throw new FixtureAuthError(`the storage state has no cookie for ${target.origin}`);
    return { cookie: jar.map((c) => `${c.name}=${c.value}`).join("; ") };
  }
  const entry = state.origins.find((o) => o.origin === target.origin)?.localStorage.find((i) => i.name === auth.key);
  if (entry === undefined || entry.value === "") {
    throw new FixtureAuthError(`the storage state has no localStorage "${auth.key}" for ${target.origin}`);
  }
  return { [auth.header ?? "authorization"]: withScheme(auth.scheme, entry.value, "Bearer") };
}
