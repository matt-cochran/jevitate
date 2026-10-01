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
  /**
   * `<header>: <scheme> <localStorage[key]>` for the request's origin (default `Authorization: Bearer`).
   * `identity` (#243): read from that named fixture identity's storageState, not the mission's.
   */
  | { readonly from: "localStorage"; readonly key: string; readonly scheme?: string; readonly header?: string; readonly identity?: string }
  /** The storageState cookies that match the request URL, as a `Cookie` header (`identity`: as above). */
  | { readonly from: "cookies"; readonly identity?: string }
  /** `<header>: <scheme> <value>` from a `--secret-field` binding, named by its env variable. */
  | { readonly from: "secretField"; readonly name: string; readonly scheme?: string; readonly header?: string };

export interface AuthSources {
  /** Path of the run's Playwright storageState JSON (`--storage-state`). */
  readonly storageStatePath?: string;
  /** `--secret-field` values by their env-variable name. */
  readonly secretFields?: Readonly<Record<string, string>>;
  /**
   * #243: named fixture identities → their storageState PATH (`--fixture-identity <name>=<file>` or a
   * targets.json persona). A step with `auth.identity` authenticates from that file only — never from
   * the mission's own `--storage-state`, so the mission can run as someone else (or cold).
   */
  readonly identities?: Readonly<Record<string, string>>;
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

function whose(auth: { readonly identity?: string }): string {
  return auth.identity === undefined ? "the storage state" : `fixture identity ${auth.identity}'s storage state`;
}

function withScheme(scheme: string | undefined, value: string, fallback: string): string {
  const s = scheme ?? fallback;
  return s === "" ? value : `${s} ${value}`;
}

/**
 * A storageState file's `localStorage[key]` for `origin` (or null) — the same lookup `authHeaders`
 * does for its `localStorage` source, exposed on its own for #173: an observer's cross-actor probe
 * authenticates from its OWN storageState file this way, with no browser and no navigation needed.
 */
export function localStorageValue(storageStatePath: string, origin: string, key: string): string | null {
  const state = readStorageState(storageStatePath);
  return state.origins.find((o) => o.origin === origin)?.localStorage.find((i) => i.name === key)?.value ?? null;
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
  let statePath: string | undefined;
  if (auth.identity !== undefined) {
    statePath = sources.identities?.[auth.identity];
    if (statePath === undefined) {
      throw new FixtureAuthError(
        `auth.identity ${auth.identity} is not bound: pass --fixture-identity ${auth.identity}=<storageState> or declare personas.${auth.identity}.storageState for this origin in targets.json`,
      );
    }
  } else {
    statePath = sources.storageStatePath;
    if (statePath === undefined) throw new FixtureAuthError(`auth from ${auth.from} needs --storage-state (or an auth.identity)`);
  }
  const state = readStorageState(statePath);
  if (auth.from === "cookies") {
    const nowSec = Date.now() / 1000;
    const jar = state.cookies.filter((c) => cookieMatches(c, target, nowSec));
    if (jar.length === 0) throw new FixtureAuthError(`${whose(auth)} has no cookie for ${target.origin}`);
    return { cookie: jar.map((c) => `${c.name}=${c.value}`).join("; ") };
  }
  const entry = state.origins.find((o) => o.origin === target.origin)?.localStorage.find((i) => i.name === auth.key);
  if (entry === undefined || entry.value === "") {
    throw new FixtureAuthError(`${whose(auth)} has no localStorage "${auth.key}" for ${target.origin}`);
  }
  return { [auth.header ?? "authorization"]: withScheme(auth.scheme, entry.value, "Bearer") };
}
