import { createHash } from "node:crypto";
import type { Page } from "playwright";
import { clock } from "@jevitate/domain";

/**
 * #300 — who the run is signed in as, so an adversarial run can tell when an action CHANGED the
 * authenticated identity (a "Continue as demo" shortcut on a login page, a "switch user" control):
 * the invariants it was given were written for the ORIGINAL identity and must never judge another.
 *
 * The identity is read from the session's own auth state — the page's cookies and its
 * `localStorage` / `sessionStorage` entries whose NAME looks auth-related — and kept as HASHES only:
 * never a raw cookie or token value (credentials never reach a model, a result, or a file). For a JWT
 * (a bare token, a `Bearer` value, or one nested in a JSON-valued entry) the hash is of its subject
 * claims (`sub`/user id/email + tenant/org), so a token refresh for the same user is not a change.
 *
 * What counts as a change (`identityChange`):
 *  - an auth entry appeared or disappeared (signed in from a logged-out page, signed out);
 *  - a token's subject claims differ (another user, another tenant);
 *  - an OPAQUE auth value (no readable subject) differs AND the action fired an auth-shaped request
 *    (`isAuthRequest`: a login / sign-in / session / verify / token call) — an opaque session cookie
 *    some frameworks re-issue on every response is not, alone, a new identity.
 * Limits: a same-named opaque session swapped without any auth-shaped request is not detected.
 */

/** One auth-looking entry: hashes only (16 hex), never the value itself. */
export interface IdentityEntry {
  /** Hash of the value. */
  readonly value: string;
  /** Hash of the token's subject claims, when the value is (or holds) a readable JWT. */
  readonly subject?: string;
}

/** The session's auth state, keyed `cookie:<name>` / `local:<key>` / `session:<key>` → hashes. */
export interface IdentityFingerprint {
  readonly entries: ReadonlyMap<string, IdentityEntry>;
  /**
   * Which sources could be read this time (`cookie`, `storage`): a page mid-navigation to an app that
   * stopped answering has no document to read storage from. Only sources read on BOTH sides compare.
   */
  readonly read: ReadonlySet<"cookie" | "storage">;
}

/** Bound on each identity read (ms): a page whose document never arrives must not stall the run. */
const READ_TIMEOUT_MS = 2_000;

function bounded<T>(p: Promise<T>): Promise<T | typeof TIMED_OUT> {
  // A read that loses the race may still reject later (the page closed): never unhandled.
  p.catch(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = clock.setTimeout(() => resolve(TIMED_OUT), READ_TIMEOUT_MS);
  });
  return Promise.race([p, timeout]).finally(() => clock.clearTimeout(timer));
}
const TIMED_OUT = Symbol("timed-out");

/** Names that look like auth state (session ids, tokens, the signed-in user). */
const AUTH_NAME = /sess|auth|token|jwt|\bsid\b|_sid|sid_|login|user|account|identity|credential|bearer/i;
/** Request paths that sign someone in / out or (re)issue a session. */
const AUTH_PATH = /log-?in|log-?out|sign-?in|sign-?up|sign-?out|register|auth|session|verify|oauth|sso|token|impersonat|switch-?user|demo/i;
const MAX_VALUE_CHARS = 16_384;

function hash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

const JWT = /^[A-Za-z0-9_-]+\.([A-Za-z0-9_-]+)\.[A-Za-z0-9_-]*$/;
const SUBJECT_CLAIMS = ["sub", "user_id", "userId", "uid", "email", "tenant", "tenant_id", "tenantId", "org", "org_id", "orgId"];

/** The subject claims of a JWT (`sub`, user id, email, tenant/org), or null when it is not one. */
function jwtSubject(token: string): string | null {
  const m = JWT.exec(token.replace(/^Bearer\s+/i, "").trim());
  if (m === null || m[1] === undefined) return null;
  try {
    const payload: unknown = JSON.parse(Buffer.from(m[1], "base64url").toString("utf8"));
    if (payload === null || typeof payload !== "object") return null;
    const rec = payload as Record<string, unknown>;
    const parts = SUBJECT_CLAIMS.flatMap((k) => (rec[k] === undefined || rec[k] === null ? [] : [`${k}=${String(rec[k])}`]));
    return parts.length === 0 ? null : parts.join("&");
  } catch {
    return null;
  }
}

/** A JSON-valued entry's subject: a nested JWT (`access_token`/`id_token`/`token`) or `user.id`/`sub`. */
function jsonSubject(value: string, depth = 0): string | null {
  if (depth > 2) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const rec = parsed as Record<string, unknown>;
  for (const k of ["access_token", "id_token", "token", "accessToken", "idToken"]) {
    const v = rec[k];
    if (typeof v === "string") {
      const s = jwtSubject(v);
      if (s !== null) return s;
    }
  }
  const user = rec.user;
  if (user !== null && typeof user === "object") {
    const id = (user as Record<string, unknown>).id ?? (user as Record<string, unknown>).email;
    if (id !== undefined && id !== null) return `user=${String(id)}`;
  }
  for (const k of ["sub", "user_id", "userId"]) if (rec[k] !== undefined && rec[k] !== null) return `${k}=${String(rec[k])}`;
  for (const v of Object.values(rec)) {
    if (typeof v === "string" && v.startsWith("{")) {
      const s = jsonSubject(v, depth + 1);
      if (s !== null) return s;
    }
  }
  return null;
}

/** Hashes one raw value at once (the raw value is dropped here — never kept). */
export function identityEntry(raw: string): IdentityEntry {
  let value = raw.slice(0, MAX_VALUE_CHARS);
  try {
    value = decodeURIComponent(value);
  } catch {
    // keep it as it is
  }
  const subject = jwtSubject(value) ?? jsonSubject(value);
  return { value: hash(value), ...(subject === null ? {} : { subject: hash(subject) }) };
}

/** Whether a cookie/storage name looks like auth state. */
export function isAuthName(name: string): boolean {
  return AUTH_NAME.test(name);
}

/**
 * Reads the page's current identity (hashes only). Never throws: what cannot be read is left out
 * (an unreadable storage, a closed page) — the caller compares like with like.
 */
export async function readIdentity(page: Page): Promise<IdentityFingerprint> {
  const entries = new Map<string, IdentityEntry>();
  const read = new Set<"cookie" | "storage">();
  try {
    const url = page.url();
    if (/^https?:/i.test(url)) {
      const cookies = await bounded(page.context().cookies(url));
      if (cookies !== TIMED_OUT) {
        read.add("cookie");
        for (const c of cookies) {
          if (isAuthName(c.name)) entries.set(`cookie:${c.name}`, identityEntry(c.value));
        }
      }
    }
  } catch {
    // no cookies readable
  }
  try {
    const stored = await bounded(page.evaluate((src: string) => {
      const re = new RegExp(src, "i");
      const out: Array<[string, string, string]> = [];
      for (const [kind, store] of [
        ["local", window.localStorage],
        ["session", window.sessionStorage],
      ] as const) {
        try {
          for (let i = 0; i < store.length; i += 1) {
            const k = store.key(i);
            if (k !== null && re.test(k)) out.push([kind, k, store.getItem(k) ?? ""]);
          }
        } catch {
          // storage blocked
        }
      }
      return out;
    }, AUTH_NAME.source));
    if (stored !== TIMED_OUT) {
      read.add("storage");
      for (const [kind, k, v] of stored) entries.set(`${kind}:${k}`, identityEntry(v));
    }
  } catch {
    // no storage readable
  }
  return { entries, read };
}

/**
 * Signs the session OUT in place: clears the context's cookies and the page's auth-named storage
 * entries. Only ever used to restore a signed-out original identity when no fresh session can be
 * opened. Never throws.
 */
export async function clearAuthState(page: Page): Promise<void> {
  await page
    .context()
    .clearCookies()
    .catch(() => undefined);
  await bounded(
    page.evaluate((src: string) => {
      const re = new RegExp(src, "i");
      for (const store of [window.localStorage, window.sessionStorage]) {
        try {
          const keys: string[] = [];
          for (let i = 0; i < store.length; i += 1) {
            const k = store.key(i);
            if (k !== null && re.test(k)) keys.push(k);
          }
          for (const k of keys) store.removeItem(k);
        } catch {
          // storage blocked
        }
      }
    }, AUTH_NAME.source),
  ).catch(() => undefined);
}

/** Whether a request (by URL) is auth-shaped: signs in/out, verifies, or (re)issues a session/token. */
export function isAuthRequest(url: string): boolean {
  try {
    return AUTH_PATH.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

/**
 * When the run's pages last fired an auth-shaped request (wall clock). Listens on every page it is
 * attached to, from the moment it is attached — a request followed by a navigation (a sign-in that
 * reloads the page) is still seen. Keeps no URL, header or body: only the time.
 */
export class AuthRequestLog {
  #last = Number.NEGATIVE_INFINITY;
  readonly #attached = new WeakSet<Page>();

  attach(page: Page): void {
    if (this.#attached.has(page)) return;
    this.#attached.add(page);
    page.on("request", (request) => {
      if (isAuthRequest(request.url())) this.#last = clock.now();
    });
  }

  /** Whether an auth-shaped request fired at or after `sinceMs`. */
  since(sinceMs: number): boolean {
    return this.#last >= sinceMs;
  }
}

/**
 * Why `now` is a different identity from `base`, or null when it is the same one. The reason names
 * auth entries by NAME only (never a value or a hash).
 */
export function identityChange(base: IdentityFingerprint, now: IdentityFingerprint, opts: { authRequest: boolean }): string | null {
  // Only sources read on both sides compare: an unreadable one is never "removed".
  const comparable = (k: string): boolean => {
    const source = k.startsWith("cookie:") ? "cookie" : "storage";
    return base.read.has(source) && now.read.has(source);
  };
  const appeared = [...now.entries.keys()].filter((k) => comparable(k) && !base.entries.has(k));
  const removed = [...base.entries.keys()].filter((k) => comparable(k) && !now.entries.has(k));
  const reasons: string[] = [];
  if (appeared.length > 0) reasons.push(`auth state appeared (${appeared.join(", ")})`);
  if (removed.length > 0) reasons.push(`auth state removed (${removed.join(", ")})`);
  for (const [k, b] of base.entries) {
    if (!comparable(k)) continue;
    const n = now.entries.get(k);
    if (n === undefined) continue;
    if (b.subject !== undefined && n.subject !== undefined) {
      if (b.subject !== n.subject) reasons.push(`the signed-in subject in ${k} changed`);
    } else if (b.value !== n.value && (opts.authRequest || b.subject !== n.subject)) {
      reasons.push(`${k} was re-issued${opts.authRequest ? " by an auth request" : ""}`);
    }
  }
  return reasons.length === 0 ? null : reasons.join("; ");
}
