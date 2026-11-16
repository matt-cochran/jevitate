import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { Page } from "playwright";
import { redactUrl } from "@jevitate/ai-core";
import { assertAuthorizedExploreTarget, isLoginLikeUrl, UnauthorizedExploreTargetError } from "@jevitate/explore";
import type { BrowserSession } from "@jevitate/playwright";
import { sessionLaunchOptions } from "./browser-run-options.js";
import { parseTokenPath, resolveLoginSecrets } from "./persona-login-parse.js";
import { performLogin, selectLoginContext, showsSignInForm } from "./persona-login-form.js";
import { assertPageAuthorized, LoginArgsError, LoginContextError, LoginFailedError, originOf, pathOf, scrub, type ApiLogin, type EnsureSession, type EnsureSessionOptions, type MintOptions, type MintResult, type SessionCheckOptions } from "./persona-login-types.js";
import { findGitRoot, sessionFileInProjectRefusal } from "./project-dir.js";

/** @public — the module's original export surface (some symbols are used only through these re-exports). */
export type { ApiLogin, AuthCheck, AuthExpiredResult, EnsureSession, EnsureSessionOptions, LoginContext, LoginSecrets, LoginSuccess, MintOptions, MintResult, PersonaLogin, SessionCheckOptions } from "./persona-login-types.js";
/** @public */
export { authExpiredResult, LoginArgsError, LoginContextError, LoginFailedError } from "./persona-login-types.js";
/** @public */
export { assertEnvVarName, loginFromFlags, parseApiLogin, parseAuthCheck, parseLoginSuccess, parsePersonaLogin, parseTokenPath, resolveLoginSecrets } from "./persona-login-parse.js";
/** @public */
export { performLogin, selectLoginContext } from "./persona-login-form.js";

/**
 * #427 — persona sessions from credentials, and the pre-flight that proves a session is still alive.
 *
 *  - `mintStorageState` (`jevitate login`, and the refresh below): opens a FRESH context (no
 *    storage state), fills the sign-in form with a username and password read from the NAMED
 *    environment variables, submits, checks success by code, and saves the context's storage state
 *    (mode 0600, written atomically). The login session records nothing: no trace, no video, no HAR,
 *    no screenshot, no transcript — and no message this module produces carries a credential (every
 *    error text passes through `redactText` with both values first).
 *  - `selectLoginContext` (#741): when the persona declares `context: {organization, role}`, the
 *    login selects each value on the app page and asserts the control took it, BEFORE the state is
 *    captured. An unavailable value fails with `LoginContextError` (`E_LOGIN_CONTEXT`); no state
 *    file is written.
 *  - `checkSession` (the pre-flight auth check): opens the start URL with the storage state and
 *    decides, by code, whether the app bounced it to a sign-in page.
 *  - `ensurePersonaSession`: the check, plus ONE re-mint when the persona has `login` parameters.
 *
 * Credentials are never accepted as literal values — only environment variable NAMES travel (flags,
 * personas files, results). Values are typed only into a page whose origin the run authorizes.
 */

// ── saving the state ──────────────────────────────────────────────────────────────────────────

/** Where a storage state goes: refused inside a repo's `.jevitate/`; a warning when it is in a repo and not ignored by git. */
export function checkSaveTarget(file: string, what: string): { readonly path: string; readonly warnings: string[] } {
  const path = resolve(file);
  const refusal = sessionFileInProjectRefusal(path, what);
  if (refusal !== undefined) throw new LoginArgsError(refusal);
  const warnings: string[] = [];
  const root = findGitRoot(dirname(path));
  if (root !== null) {
    const rel = relative(root, path);
    if (rel !== "" && !rel.startsWith("..") && !isAbsolute(rel)) {
      // #753: under load a spawn can fail transiently (git killed, a null status) — retry once
      // before warning "could not be checked". A real git failure (twice) still warns.
      const checkIgnored = (): boolean | undefined => {
        try {
          execFileSync("git", ["check-ignore", "-q", "--no-index", "--", rel], { cwd: root, stdio: "ignore" });
          return true;
        } catch (err) {
          return (err as { status?: number }).status === 1 ? false : undefined;
        }
      };
      let ignored = checkIgnored();
      if (ignored === undefined) ignored = checkIgnored();
      if (ignored !== true) {
        warnings.push(
          `${what} ${path} is inside the git repository ${root} and ${ignored === false ? "is not gitignored" : "could not be checked against .gitignore"}: it holds live session tokens — add it to .gitignore or save it outside the repo`,
        );
      }
    }
  }
  return { path, warnings };
}

/** Writes the storage state JSON atomically with mode 0600 (a temp file in the same directory, then rename). */
export function writeStorageStateFile(path: string, json: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  try {
    writeFileSync(tmp, json, { encoding: "utf8", mode: 0o600, flag: "wx" });
    chmodSync(tmp, 0o600);
    renameSync(tmp, path);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

function assertLoginOriginAuthorized(url: string, allowlist: readonly string[], what: string): void {
  try {
    assertAuthorizedExploreTarget(url, allowlist);
  } catch (err) {
    if (err instanceof UnauthorizedExploreTargetError) throw new LoginArgsError(`${what} ${JSON.stringify(redactUrl(url))} is not an authorized origin (allowed: ${allowlist.join(", ") || "<none>"}) — refused`);
    throw err;
  }
}

/** Signs in on a fresh, unrecorded session and saves its storage state (mode 0600). */
export async function mintStorageState(o: MintOptions): Promise<MintResult> {
  if (o.login.api !== undefined) return mintApiStorageState(o, o.login.api);
  if (o.login.url === undefined) throw new LoginArgsError("the login parameters name neither a sign-in page (url) nor an endpoint (api)");
  const save = resolve(o.save);
  const refusal = sessionFileInProjectRefusal(save, "the storage state");
  if (refusal !== undefined) throw new LoginArgsError(refusal);
  assertLoginOriginAuthorized(o.login.url, o.allowlist, "login URL");
  const secrets = resolveLoginSecrets(o.login, o.env);
  // Never recorded: no video directory, no tracing, no screenshots — whatever the run's own flags say.
  const { recordVideo: _video, ...launch } = o.browser ?? {};
  let session: BrowserSession | undefined;
  try {
    session = await o.port.open({ ...sessionLaunchOptions(launch), allowedOrigins: [...o.allowlist], baseUrl: o.login.url });
    const landed = await performLogin(session.page, o.login, secrets, { allowlist: o.allowlist, timeoutMs: o.timeoutMs });
    if (o.context !== undefined) await selectLoginContext(session.page, o.context, { login: o.login, timeoutMs: o.timeoutMs });
    const state = session.captureStorageState !== undefined ? await session.captureStorageState() : JSON.stringify(await session.page.context().storageState());
    writeStorageStateFile(save, state);
    return { saved: save, landedUrl: scrub(redactUrl(landed), secrets) };
  } catch (err) {
    if (err instanceof LoginFailedError || err instanceof LoginArgsError) throw err;
    if (err instanceof LoginContextError) throw new LoginContextError(scrub(err.message, secrets));
    throw new LoginFailedError(scrub(`the sign-in failed: ${err instanceof Error ? err.message.split("\n")[0]! : String(err)}`, secrets));
  } finally {
    await session?.close().catch(() => undefined);
  }
}

/** The value at a dotted path in a parsed JSON body (own properties only), or undefined. */
function valueAtPath(body: unknown, segments: readonly string[]): unknown {
  let cur: unknown = body;
  for (const s of segments) {
    if (cur === null || typeof cur !== "object" || !Object.prototype.hasOwnProperty.call(cur, s)) return undefined;
    cur = (cur as Record<string, unknown>)[s];
  }
  return cur;
}

/** The app page an API login's session is proven on (and whose origin receives the token). */
export function apiVerifyUrl(api: ApiLogin): string {
  return api.verifyUrl ?? `${new URL(api.url).origin}/`;
}

/**
 * #449: signs in through an HTTP endpoint. The credentials are POSTed as JSON (from a fresh,
 * unrecorded browser context, so the response's `Set-Cookie` lands in its cookie jar); redirects are
 * never followed. The storage state is the context's cookies plus, with a token path, the token
 * written into the verify URL origin's localStorage. Every message is scrubbed of both credentials
 * and the token; a failed sign-in or verification writes nothing.
 */
async function mintApiStorageState(o: MintOptions, api: ApiLogin): Promise<MintResult> {
  const save = resolve(o.save);
  const refusal = sessionFileInProjectRefusal(save, "the storage state");
  if (refusal !== undefined) throw new LoginArgsError(refusal);
  const appUrl = apiVerifyUrl(api);
  assertLoginOriginAuthorized(api.url, o.allowlist, "login endpoint");
  assertLoginOriginAuthorized(appUrl, o.allowlist, "the app page (--verify-url)");
  if (o.verify !== undefined) assertLoginOriginAuthorized(o.verify.url, o.allowlist, "the app page (--verify-url)");
  const secrets = resolveLoginSecrets(o.login, o.env);
  const segments = api.tokenPath === undefined ? undefined : parseTokenPath(api.tokenPath, "--token-path");
  const { recordVideo: _video, ...launch } = o.browser ?? {};
  let session: BrowserSession | undefined;
  let token: string | undefined;
  let tmp: string | undefined;
  try {
    session = await o.port.open({ ...sessionLaunchOptions(launch), allowedOrigins: [...o.allowlist], baseUrl: appUrl });
    const context = session.page.context();
    const response = await context.request.post(api.url, {
      data: { [api.userKey]: secrets.username, [api.passwordKey]: secrets.password },
      headers: { accept: "application/json" },
      maxRedirects: 0,
      failOnStatusCode: false,
      timeout: o.timeoutMs,
    });
    const status = response.status();
    const where = pathOf(api.url);
    if (status >= 300 && status < 400) {
      const location = response.headers()["location"];
      const target = location === undefined ? undefined : originOf(new URL(location, api.url).href);
      if (target !== undefined && target !== new URL(api.url).origin) {
        throw new LoginFailedError(`the sign-in endpoint ${where} redirected (HTTP ${status}) to another origin, ${target} — redirects are never followed`);
      }
      if (segments !== undefined) throw new LoginFailedError(`the sign-in endpoint ${where} answered HTTP ${status} (a redirect, not followed), not a JSON body holding --token-path ${api.tokenPath}`);
    } else if (status < 200 || status >= 300) {
      throw new LoginFailedError(`the sign-in endpoint ${where} answered HTTP ${status} — the credentials in ${o.login.userEnv}/${o.login.passwordEnv} were not accepted`);
    }
    if (segments !== undefined) {
      let body: unknown;
      try {
        body = JSON.parse(await response.text());
      } catch {
        throw new LoginFailedError(`the sign-in endpoint ${where} answered HTTP ${status} with a body that is not JSON — --token-path ${api.tokenPath} cannot be read`);
      }
      const v = valueAtPath(body, segments);
      if (typeof v === "number" && Number.isFinite(v)) token = String(v);
      else if (typeof v === "string" && v !== "") token = v;
      else throw new LoginFailedError(`the sign-in endpoint's JSON response has no ${v === undefined || v === null ? "value" : "string value"} at --token-path ${api.tokenPath}`);
    }
    if (o.context !== undefined) {
      // #741: prove the declared organization/role on the app page BEFORE the state is captured.
      await session.page.goto(appUrl, { waitUntil: "load", timeout: o.timeoutMs });
      if (token !== undefined && api.storageKey !== undefined) {
        await session.page.evaluate((args: readonly [string, string]) => window.localStorage.setItem(args[0], args[1]), [api.storageKey, token] as const);
        await session.page.reload({ waitUntil: "load", timeout: o.timeoutMs });
      }
      assertPageAuthorized(session.page, o.allowlist);
      await selectLoginContext(session.page, o.context, { login: o.login, timeoutMs: o.timeoutMs });
    }
    const raw = session.captureStorageState !== undefined ? await session.captureStorageState() : JSON.stringify(await context.storageState());
    const state = JSON.parse(raw) as { cookies?: unknown[]; origins?: Array<{ origin: string; localStorage: Array<{ name: string; value: string }> }> };
    if (token === undefined && (state.cookies ?? []).length === 0) {
      throw new LoginFailedError(`the sign-in endpoint ${where} answered HTTP ${status} but set no cookie — name the token in its JSON response with --token-path`);
    }
    if (token !== undefined) {
      const origin = new URL(appUrl).origin;
      const origins = (state.origins ?? []).filter((x) => x.origin !== origin);
      const existing = (state.origins ?? []).find((x) => x.origin === origin)?.localStorage ?? [];
      origins.push({ origin, localStorage: [...existing.filter((e) => e.name !== api.storageKey), { name: api.storageKey!, value: token }] });
      state.origins = origins;
    }
    await session.close().catch(() => undefined);
    session = undefined;
    let landed = appUrl;
    const json = JSON.stringify(state);
    if (o.verify === undefined) {
      writeStorageStateFile(save, json);
    } else {
      // Proven before it replaces anything: the check runs on a 0600 temp file beside the target.
      tmp = join(dirname(save), `.${basename(save)}.${randomUUID()}.verify.json`);
      writeStorageStateFile(tmp, json);
      const verdict = await checkSession({ storageState: tmp, url: o.verify.url, allowlist: o.allowlist, check: o.verify.check, port: o.port, ...(o.browser === undefined ? {} : { browser: o.browser }), timeoutMs: o.timeoutMs });
      if (!verdict.ok) throw new LoginFailedError(`signed in through ${where}, but ${verdict.reason.replace(basename(tmp), "the new storage state")} — nothing saved`);
      if (verdict.landedUrl !== undefined) landed = verdict.landedUrl;
      renameSync(tmp, save);
      tmp = undefined;
    }
    return { saved: save, landedUrl: scrub(redactUrl(landed), secrets, token) };
  } catch (err) {
    if (err instanceof LoginFailedError) throw new LoginFailedError(scrub(err.message, secrets, token));
    if (err instanceof LoginArgsError) throw new LoginArgsError(scrub(err.message, secrets, token));
    if (err instanceof LoginContextError) throw new LoginContextError(scrub(err.message, secrets, token));
    throw new LoginFailedError(scrub(`the sign-in failed: ${err instanceof Error ? err.message.split("\n")[0]! : String(err)}`, secrets, token));
  } finally {
    if (tmp !== undefined) rmSync(tmp, { force: true });
    await session?.close().catch(() => undefined);
  }
}

// ── the pre-flight auth check ─────────────────────────────────────────────────────────────────

export type SessionCheck = { readonly ok: true; readonly landedUrl?: string } | { readonly ok: false; readonly reason: string; readonly landedUrl: string };

/** How long the check waits for a client-side redirect (an SPA that asks its API, then routes to /login). */
const SETTLE_MS = 3_000;

/**
 * Opens `url` with the storage state and decides by code whether the session is alive. A start URL
 * that is itself a sign-in route is never judged (`auto`). An unreachable app is NOT an expired
 * session: the check passes it on and the mission reports the app as unreachable, as before.
 */
export async function checkSession(o: SessionCheckOptions): Promise<SessionCheck> {
  if (o.check.mode === "off") return { ok: true };
  if (o.check.mode === "auto" && isLoginLikeUrl(o.url)) return { ok: true };
  assertAuthorizedExploreTarget(o.url, o.allowlist);
  const { recordVideo: _video, ...launch } = o.browser ?? {};
  const session = await o.port.open({ ...sessionLaunchOptions(launch), storageState: o.storageState, allowedOrigins: [...o.allowlist], baseUrl: o.url });
  try {
    if ((await session.probeReachable?.(o.url)) != null) return { ok: true };
    const page = session.page;
    try {
      await page.goto(o.url, { waitUntil: "load", timeout: o.timeoutMs });
    } catch {
      return { ok: true }; // a navigation failure is the mission's to report, not an auth verdict
    }
    await page.waitForLoadState("networkidle", { timeout: SETTLE_MS }).catch(() => undefined);
    const verdict = await judgeLanding(page, o);
    // A rotating session (a refresh cookie replaced on every use) was just used by the check: the
    // live one is written back, so the mission starts from it rather than from a consumed token.
    if (verdict.ok) await keepRotatedSession(session, o.storageState);
    return verdict;
  } finally {
    await session.close().catch(() => undefined);
  }
}

/** The check's verdict on the page the start URL landed on. */
async function judgeLanding(page: Page, o: SessionCheckOptions): Promise<SessionCheck> {
  const landed = page.url();
  const where = redactUrl(landed);
  const state = basename(o.storageState);
  switch (o.check.mode) {
    case "auto": {
      if (isLoginLikeUrl(landed)) {
        return { ok: false, landedUrl: where, reason: `the session in ${state} is not signed in: ${pathOf(o.url)} redirected to the sign-in page ${pathOf(landed)}` };
      }
      if (await showsSignInForm(page)) {
        return { ok: false, landedUrl: where, reason: `the session in ${state} is not signed in: ${pathOf(landed)} shows a sign-in form (a password field with a username field or a sign-in button)` };
      }
      return { ok: true, landedUrl: where };
    }
    case "urlExcludes":
      return landed.includes(o.check.text)
        ? { ok: false, landedUrl: where, reason: `the session in ${state} is not signed in: the start page landed on ${pathOf(landed)}, which includes ${JSON.stringify(o.check.text)} (--auth-check)` }
        : { ok: true, landedUrl: where };
    case "selector": {
      const visible = await page
        .locator(o.check.selector)
        .first()
        .waitFor({ state: "visible", timeout: Math.min(o.timeoutMs, 5_000) })
        .then(() => true)
        .catch(() => false);
      return visible
        ? { ok: true, landedUrl: where }
        : { ok: false, landedUrl: where, reason: `the session in ${state} is not signed in: the signed-in marker ${JSON.stringify(o.check.selector)} is not visible on ${pathOf(landed)} (--auth-check)` };
    }
    case "off":
      return { ok: true, landedUrl: where };
  }
}

/** `name@domain/path` → value for a storage state's cookies, and `origin key` → value for its localStorage. */
function sessionValues(json: string): Map<string, string> | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return undefined;
  }
  const o = (raw ?? {}) as { cookies?: unknown; origins?: unknown };
  const out = new Map<string, string>();
  for (const c of Array.isArray(o.cookies) ? o.cookies : []) {
    const k = c as { name?: unknown; domain?: unknown; path?: unknown; value?: unknown };
    if (typeof k.name === "string" && typeof k.value === "string") out.set(`cookie ${k.name}@${String(k.domain)}${String(k.path ?? "/")}`, k.value);
  }
  for (const x of Array.isArray(o.origins) ? o.origins : []) {
    const origin = x as { origin?: unknown; localStorage?: unknown };
    for (const e of Array.isArray(origin.localStorage) ? origin.localStorage : []) {
      const kv = e as { name?: unknown; value?: unknown };
      if (typeof kv.name === "string" && typeof kv.value === "string") out.set(`local ${String(origin.origin)} ${kv.name}`, kv.value);
    }
  }
  return out;
}

/**
 * Writes the check's live session back over `file` when a value the file held changed or was
 * removed during the check (a rotated refresh token). Untouched otherwise; never inside a repo's
 * `.jevitate/`; best effort (the mission's own `sessionLost` warning still catches a lost session).
 */
async function keepRotatedSession(session: BrowserSession, file: string): Promise<void> {
  if (session.captureStorageState === undefined || sessionFileInProjectRefusal(file, "the storage state") !== undefined) return;
  try {
    const before = sessionValues(readFileSync(file, "utf8"));
    const live = await session.captureStorageState();
    const after = sessionValues(live);
    if (before === undefined || after === undefined) return;
    const rotated = [...before].some(([k, v]) => after.get(k) !== v);
    if (rotated) writeStorageStateFile(file, live);
  } catch {
    // best effort: the state file is left as it was
  }
}

/** The pre-flight: check the session; when it is expired and login parameters exist, re-mint once and re-check. */
export async function ensurePersonaSession(o: EnsureSessionOptions): Promise<EnsureSession> {
  if (o.check.mode === "off") return { ok: true, refreshed: false };
  const who = o.persona === undefined ? "the session" : `persona ${o.persona}`;
  let first: SessionCheck | undefined;
  if (existsSync(o.storageState)) {
    first = await checkSession(o);
    if (first.ok) return { ok: true, refreshed: false };
  }
  const expired = first === undefined || first.ok ? `the storage state ${basename(o.storageState)} does not exist yet` : first.reason;
  const landedUrl = first !== undefined && !first.ok ? first.landedUrl : undefined;
  if (o.login === undefined) return { ok: false, reason: expired, ...(landedUrl === undefined ? {} : { landedUrl }) };
  try {
    await mintStorageState({ login: o.login, save: o.storageState, allowlist: o.allowlist, env: o.env, port: o.port, ...(o.browser === undefined ? {} : { browser: o.browser }), ...(o.context === undefined ? {} : { context: o.context }), timeoutMs: o.timeoutMs });
  } catch (err) {
    if (!(err instanceof LoginFailedError) && !(err instanceof LoginArgsError)) throw err;
    return { ok: false, reason: `${expired}; re-signing in ${who} failed: ${err.message}`, ...(landedUrl === undefined ? {} : { landedUrl }) };
  }
  o.note?.(`jevitate: ${who}: ${expired} — signed in again from its login parameters and saved ${basename(o.storageState)}\n`);
  const second = await checkSession(o);
  if (second.ok) return { ok: true, refreshed: true };
  return { ok: false, reason: `${second.reason} (even right after signing in again)`, landedUrl: second.landedUrl };
}
