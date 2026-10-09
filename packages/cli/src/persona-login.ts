import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { Locator, Page } from "playwright";
import { redactText, redactUrl } from "@jevitate/ai-core";
import { clock } from "@jevitate/domain";
import { assertAuthorizedExploreTarget, isLoginLikeUrl, UnauthorizedExploreTargetError } from "@jevitate/explore";
import type { BrowserPort, BrowserSession } from "@jevitate/playwright";
import { sessionLaunchOptions, type BrowserRunOptions } from "./browser-run-options.js";
import { findGitRoot, sessionFileInProjectRefusal } from "./project-dir.js";

/**
 * #427 — persona sessions from credentials, and the pre-flight that proves a session is still alive.
 *
 *  - `mintStorageState` (`jevitate login`, and the refresh below): opens a FRESH context (no
 *    storage state), fills the sign-in form with a username and password read from the NAMED
 *    environment variables, submits, checks success by code, and saves the context's storage state
 *    (mode 0600, written atomically). The login session records nothing: no trace, no video, no HAR,
 *    no screenshot, no transcript — and no message this module produces carries a credential (every
 *    error text passes through `redactText` with both values first).
 *  - `checkSession` (the pre-flight auth check): opens the start URL with the storage state and
 *    decides, by code, whether the app bounced it to a sign-in page.
 *  - `ensurePersonaSession`: the check, plus ONE re-mint when the persona has `login` parameters.
 *
 * Credentials are never accepted as literal values — only environment variable NAMES travel (flags,
 * personas files, results). Values are typed only into a page whose origin the run authorizes.
 */

// ── configuration ─────────────────────────────────────────────────────────────────────────────

/**
 * #449: a sign-in through an HTTP endpoint (`jevitate login --api`, a personas file's `login.api`):
 * the credentials are POSTed as JSON, and the response's cookies and/or a token read from its JSON
 * body (written into the app origin's localStorage) become the storage state. No form is driven.
 */
export interface ApiLogin {
  /** The sign-in endpoint (absolute http(s) URL on an authorized origin). */
  readonly url: string;
  /** The JSON body key the username is sent under (default `username`). */
  readonly userKey: string;
  /** The JSON body key the password is sent under (default `password`). */
  readonly passwordKey: string;
  /** A simple dotted path into the JSON response (`token`, `data.accessToken`) whose value is the session token. */
  readonly tokenPath?: string;
  /** The localStorage key the token is written under (default: the token path's last segment). */
  readonly storageKey?: string;
  /** Where the token goes: only `local` (a Playwright storage state has no sessionStorage). */
  readonly storage: "local";
  /** The page that proves the session (`--verify-url`); default the endpoint's origin root. Its origin receives the token. */
  readonly verifyUrl?: string;
}

/** A persona's login parameters (`jevitate login` flags, or a personas file entry's `login`). */
export interface PersonaLogin {
  /** The sign-in page (absolute http(s) URL) — the form path. Exactly one of `url` and `api` is set. */
  readonly url?: string;
  /** #449: sign in through an HTTP endpoint instead of a form. */
  readonly api?: ApiLogin;
  /** Environment variable holding the username (its NAME — never the value). */
  readonly userEnv: string;
  /** Environment variable holding the password (its NAME — never the value). */
  readonly passwordEnv: string;
  /** The username field: a label, else a CSS selector. Default: found by autocomplete/type/name heuristics. */
  readonly userField?: string;
  /** The password field: a label, else a CSS selector. Default: the visible `input[type=password]`. */
  readonly passwordField?: string;
  /** The submit button's accessible name. Default: the form's submit button, else Enter. */
  readonly submit?: string;
  /** `urlIncludes:<text>` | `selector:<css>` | `text:<text>`. Default: no password field and no login-like URL. */
  readonly success?: string;
}

export class LoginArgsError extends Error {
  readonly code = "E_LOGIN_ARGS" as const;
  constructor(message: string) {
    super(message);
    this.name = "LoginArgsError";
  }
}

/** The login did not succeed (credentials rejected, a field not found, the success check never held). */
export class LoginFailedError extends Error {
  readonly code = "E_LOGIN_FAILED" as const;
  constructor(message: string) {
    super(message);
    this.name = "LoginFailedError";
  }
}

const VAR_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** jevitate's own credentials are never typed into a page (a login config cannot name them). */
const RESERVED_VARS = new Set(["OPENROUTER_API_KEY", "TYPESAFE_API_KEY", "GITHUB_TOKEN"]);

/** Checks an environment variable NAME (a value pasted in its place is never echoed). */
export function assertEnvVarName(name: string, what: string): void {
  if (!VAR_NAME.test(name)) {
    throw new LoginArgsError(`${what} expects an environment variable NAME (letters, digits, _; not starting with a digit) — the credential itself is read from the environment, never passed as a value`);
  }
  if (RESERVED_VARS.has(name) || name.startsWith("JEVITATE_")) {
    throw new LoginArgsError(`${what} ${name}: jevitate's own credentials and settings are never typed into a page`);
  }
}

function httpUrl(v: string, what: string): string {
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    throw new LoginArgsError(`${what} must be an absolute http(s) URL`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new LoginArgsError(`${what} must be an absolute http(s) URL`);
  if (u.username !== "" || u.password !== "") throw new LoginArgsError(`${what} must not carry credentials in the URL`);
  return u.href;
}

const LOGIN_KEYS = ["url", "api", "userEnv", "passwordEnv", "userField", "passwordField", "submit", "success"] as const;
/** The keys only a form sign-in uses (refused beside `api`). */
const FORM_ONLY_KEYS = ["url", "userField", "passwordField", "submit", "success"] as const;
const API_KEYS = ["url", "userKey", "passwordKey", "tokenPath", "storageKey", "storage", "verifyUrl"] as const;

/** A JSON body key: a plain identifier (letters, digits, `_`, `-`). */
const BODY_KEY = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;
/** One segment of a token path: an identifier or an array index. */
const PATH_SEGMENT = /^(?:[A-Za-z_][A-Za-z0-9_-]{0,63}|0|[1-9][0-9]{0,5})$/;
const UNSAFE_SEGMENTS = new Set(["__proto__", "prototype", "constructor"]);
/** A storage key: a safe identifier (letters, digits, `_`, `-`, `.`, `:`, `$`). */
const STORAGE_KEY = /^[A-Za-z_$][A-Za-z0-9_$.:-]{0,127}$/;

/** The names an API login's settings go by in error messages (flags, or a personas file's `login.api.*`). */
interface ApiLoginLabels {
  readonly url: string;
  readonly userKey: string;
  readonly passwordKey: string;
  readonly tokenPath: string;
  readonly storageKey: string;
  readonly storage: string;
  readonly verifyUrl: string;
}

const FLAG_LABELS: ApiLoginLabels = {
  url: "--api",
  userKey: "--api-user-key",
  passwordKey: "--api-password-key",
  tokenPath: "--token-path",
  storageKey: "--storage-key",
  storage: "--storage",
  verifyUrl: "--verify-url",
};

/** `a.b.0.c` → its segments (strict: identifiers or indexes, no prototype keys). */
export function parseTokenPath(path: string, what: string): string[] {
  const segments = path.split(".");
  if (segments.length > 8 || segments.some((s) => !PATH_SEGMENT.test(s) || UNSAFE_SEGMENTS.has(s))) {
    throw new LoginArgsError(`${what} must be a simple dotted path of identifiers or array indexes (e.g. token, data.accessToken; at most 8 segments), got ${JSON.stringify(path)}`);
  }
  return segments;
}

/** Validates an API login's settings (fail closed before any network). */
export function parseApiLogin(
  raw: {
    readonly url: string;
    readonly userKey?: string | undefined;
    readonly passwordKey?: string | undefined;
    readonly tokenPath?: string | undefined;
    readonly storageKey?: string | undefined;
    readonly storage?: string | undefined;
    readonly verifyUrl?: string | undefined;
  },
  labels: ApiLoginLabels = FLAG_LABELS,
): ApiLogin {
  const url = httpUrl(raw.url, labels.url);
  for (const [k, label] of [["userKey", labels.userKey], ["passwordKey", labels.passwordKey]] as const) {
    const v = raw[k];
    if (v !== undefined && !BODY_KEY.test(v)) throw new LoginArgsError(`${label} must be a JSON key of letters, digits, _ or - (starting with a letter or _), got ${JSON.stringify(v)}`);
  }
  const userKey = raw.userKey ?? "username";
  const passwordKey = raw.passwordKey ?? "password";
  if (userKey === passwordKey) throw new LoginArgsError(`${labels.userKey} and ${labels.passwordKey} must differ (both are ${JSON.stringify(userKey)})`);
  if (raw.storage !== undefined && raw.storage !== "local") {
    if (raw.storage === "session") {
      throw new LoginArgsError(
        `${labels.storage} session is not supported: a Playwright storage state holds cookies and localStorage only, so a sessionStorage token could not be saved or restored — use ${labels.storage} local, or a cookie session`,
      );
    }
    throw new LoginArgsError(`${labels.storage} must be local, got ${JSON.stringify(raw.storage)}`);
  }
  let segments: string[] | undefined;
  if (raw.tokenPath !== undefined) segments = parseTokenPath(raw.tokenPath, labels.tokenPath);
  else if (raw.storageKey !== undefined || raw.storage !== undefined) throw new LoginArgsError(`${labels.storageKey}/${labels.storage} place the token ${labels.tokenPath} reads: pass ${labels.tokenPath} too`);
  if (raw.storageKey !== undefined && !STORAGE_KEY.test(raw.storageKey)) {
    throw new LoginArgsError(`${labels.storageKey} must be a safe identifier (letters, digits, _ $ . : -; starting with a letter, _ or $), got ${JSON.stringify(raw.storageKey)}`);
  }
  const storageKey = raw.storageKey ?? segments?.at(-1);
  if (storageKey !== undefined && !STORAGE_KEY.test(storageKey)) {
    throw new LoginArgsError(`${labels.tokenPath} ends in ${JSON.stringify(storageKey)}, which is not a storage key: name one with ${labels.storageKey}`);
  }
  return {
    url,
    userKey,
    passwordKey,
    ...optional("tokenPath", raw.tokenPath),
    ...optional("storageKey", storageKey),
    storage: "local",
    ...optional("verifyUrl", raw.verifyUrl === undefined ? undefined : httpUrl(raw.verifyUrl, labels.verifyUrl)),
  };
}

/** Validates a personas file entry's `login` object (`where` names it in errors). */
export function parsePersonaLogin(v: unknown, where: string): PersonaLogin {
  if (v === null || typeof v !== "object" || Array.isArray(v)) throw new LoginArgsError(`${where} must be an object {url | api, userEnv, passwordEnv, …}`);
  const o = v as Record<string, unknown>;
  for (const k of Object.keys(o)) {
    if (!(LOGIN_KEYS as readonly string[]).includes(k)) {
      throw new LoginArgsError(`${where}.${k}: unknown key (allowed: ${LOGIN_KEYS.join(", ")}; credentials are read from the environment variables userEnv/passwordEnv name)`);
    }
  }
  const str = (from: Record<string, unknown>, k: string, label: string, required: boolean): string | undefined => {
    const x = from[k];
    if (x === undefined && !required) return undefined;
    if (typeof x !== "string" || x.trim() === "") throw new LoginArgsError(`${label} must be a non-empty string`);
    return x;
  };
  const userEnv = str(o, "userEnv", `${where}.userEnv`, true)!;
  const passwordEnv = str(o, "passwordEnv", `${where}.passwordEnv`, true)!;
  let login: PersonaLogin;
  if (o.api !== undefined) {
    const formKeys = FORM_ONLY_KEYS.filter((k) => o[k] !== undefined);
    if (formKeys.length > 0) throw new LoginArgsError(`${where}: api signs in through an HTTP endpoint — the form keys ${formKeys.join(", ")} do not apply beside it`);
    const a = typeof o.api === "string" ? { url: o.api } : o.api;
    if (a === null || typeof a !== "object" || Array.isArray(a)) throw new LoginArgsError(`${where}.api must be the endpoint URL or an object {url, userKey?, passwordKey?, tokenPath?, storageKey?, storage?, verifyUrl?}`);
    const ao = a as Record<string, unknown>;
    for (const k of Object.keys(ao)) {
      if (!(API_KEYS as readonly string[]).includes(k)) throw new LoginArgsError(`${where}.api.${k}: unknown key (allowed: ${API_KEYS.join(", ")})`);
    }
    const label = (k: string): string => `${where}.api${typeof o.api === "string" && k === "url" ? "" : `.${k}`}`;
    const api = parseApiLogin(
      {
        url: str(ao, "url", label("url"), true)!,
        userKey: str(ao, "userKey", label("userKey"), false),
        passwordKey: str(ao, "passwordKey", label("passwordKey"), false),
        tokenPath: str(ao, "tokenPath", label("tokenPath"), false),
        storageKey: str(ao, "storageKey", label("storageKey"), false),
        storage: str(ao, "storage", label("storage"), false),
        verifyUrl: str(ao, "verifyUrl", label("verifyUrl"), false),
      },
      { url: label("url"), userKey: label("userKey"), passwordKey: label("passwordKey"), tokenPath: label("tokenPath"), storageKey: label("storageKey"), storage: label("storage"), verifyUrl: label("verifyUrl") },
    );
    login = { api, userEnv, passwordEnv };
  } else {
    login = {
      url: httpUrl(str(o, "url", `${where}.url`, true)!, `${where}.url`),
      userEnv,
      passwordEnv,
      ...optional("userField", str(o, "userField", `${where}.userField`, false)),
      ...optional("passwordField", str(o, "passwordField", `${where}.passwordField`, false)),
      ...optional("submit", str(o, "submit", `${where}.submit`, false)),
      ...optional("success", str(o, "success", `${where}.success`, false)),
    };
  }
  assertEnvVarName(login.userEnv, `${where}.userEnv`);
  assertEnvVarName(login.passwordEnv, `${where}.passwordEnv`);
  if (login.success !== undefined) parseLoginSuccess(login.success);
  return login;
}

function optional<K extends string, V>(k: K, v: V | undefined): { [P in K]?: V } {
  return (v === undefined ? {} : { [k]: v }) as { [P in K]?: V };
}

/** `jevitate login`'s flags → a validated `PersonaLogin` (fail closed before any browser opens). */
export function loginFromFlags(f: {
  readonly url?: string;
  readonly api?: Parameters<typeof parseApiLogin>[0];
  readonly userEnv: string;
  readonly passwordEnv: string;
  readonly userField?: string;
  readonly passwordField?: string;
  readonly submit?: string;
  readonly success?: string;
}): PersonaLogin {
  if (f.api !== undefined) {
    if (f.url !== undefined) throw new LoginArgsError("--api and --url are two ways to sign in: pass one");
    const formFlags = (
      [
        ["--user-field", f.userField],
        ["--password-field", f.passwordField],
        ["--submit", f.submit],
        ["--success", f.success],
      ] as const
    )
      .filter(([, v]) => v !== undefined)
      .map(([k]) => k);
    if (formFlags.length > 0) throw new LoginArgsError(`--api signs in through an HTTP endpoint, not a form: ${formFlags.join(", ")} ${formFlags.length === 1 ? "does" : "do"} not apply`);
    const login: PersonaLogin = { api: parseApiLogin(f.api), userEnv: f.userEnv, passwordEnv: f.passwordEnv };
    assertEnvVarName(login.userEnv, "--user-env");
    assertEnvVarName(login.passwordEnv, "--password-env");
    return login;
  }
  if (f.url === undefined) throw new LoginArgsError("missing --url (or --api)");
  const login: PersonaLogin = {
    url: httpUrl(f.url, "--url"),
    userEnv: f.userEnv,
    passwordEnv: f.passwordEnv,
    ...optional("userField", f.userField),
    ...optional("passwordField", f.passwordField),
    ...optional("submit", f.submit),
    ...optional("success", f.success),
  };
  assertEnvVarName(login.userEnv, "--user-env");
  assertEnvVarName(login.passwordEnv, "--password-env");
  if (login.success !== undefined) parseLoginSuccess(login.success);
  return login;
}

export type LoginSuccess =
  | { readonly kind: "urlIncludes"; readonly text: string }
  | { readonly kind: "selector"; readonly selector: string }
  | { readonly kind: "text"; readonly text: string };

/** `urlIncludes:<text>` | `selector:<css>` | `text:<text>`. */
export function parseLoginSuccess(spec: string): LoginSuccess {
  const ci = spec.indexOf(":");
  const kind = ci === -1 ? "" : spec.slice(0, ci);
  const rest = ci === -1 ? "" : spec.slice(ci + 1);
  if ((kind === "urlIncludes" || kind === "selector" || kind === "text") && rest.trim() !== "") {
    return kind === "selector" ? { kind, selector: rest } : { kind, text: rest };
  }
  throw new LoginArgsError(`--success must be urlIncludes:<text>, selector:<css> or text:<text>, got ${JSON.stringify(spec)}`);
}

export type AuthCheck =
  | { readonly mode: "off" }
  | { readonly mode: "auto" }
  | { readonly mode: "urlExcludes"; readonly text: string }
  | { readonly mode: "selector"; readonly selector: string };

/** `--auth-check <off|auto|urlExcludes:<text>|selector:<css>>` (default `auto`). */
export function parseAuthCheck(spec: string | undefined): AuthCheck {
  if (spec === undefined || spec === "auto") return { mode: "auto" };
  if (spec === "off") return { mode: "off" };
  const ci = spec.indexOf(":");
  const kind = ci === -1 ? "" : spec.slice(0, ci);
  const rest = ci === -1 ? "" : spec.slice(ci + 1);
  if (kind === "urlExcludes" && rest !== "") return { mode: "urlExcludes", text: rest };
  if (kind === "selector" && rest !== "") return { mode: "selector", selector: rest };
  throw new LoginArgsError(`--auth-check must be off, auto, urlExcludes:<text> or selector:<css>, got ${JSON.stringify(spec)}`);
}

// ── credentials ───────────────────────────────────────────────────────────────────────────────

export interface LoginSecrets {
  readonly username: string;
  readonly password: string;
}

/** Reads the two credentials from the environment (fail closed: unset/empty refuses, naming the variable only). */
export function resolveLoginSecrets(login: PersonaLogin, env: Readonly<Record<string, string | undefined>>): LoginSecrets {
  const read = (name: string, what: string): string => {
    const v = env[name];
    if (v === undefined || v === "") throw new LoginArgsError(`${what}: environment variable ${name} is not set`);
    return v;
  };
  return { username: read(login.userEnv, "--user-env"), password: read(login.passwordEnv, "--password-env") };
}

/** Removes both credentials, and any session token read (#449), (and URL credentials/tokens) from a text before it leaves this module. */
function scrub(text: string, secrets: LoginSecrets, token?: string): string {
  return redactText(text, token === undefined ? [secrets.password, secrets.username] : [token, secrets.password, secrets.username]);
}

// ── the login ─────────────────────────────────────────────────────────────────────────────────

const VISIBLE_PASSWORD = 'input[type="password"]';
const TEXT_INPUT = 'input:not([type="password"]):not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([type="submit"]):not([type="button"]):not([type="image"]):not([type="file"])';

/** The first VISIBLE element over the candidates, in order (an invalid selector is skipped, never thrown). */
async function firstVisible(candidates: readonly Locator[]): Promise<Locator | undefined> {
  for (const c of candidates) {
    try {
      const v = c.filter({ visible: true });
      if ((await v.count()) > 0) return v.first();
    } catch {
      // an unparseable selector (a label given where CSS was tried) matches nothing
    }
  }
  return undefined;
}

/** A field named by the operator: a label first (exact, then loose), else CSS. */
function fieldBySpec(page: Page, spec: string): Locator[] {
  return [page.getByLabel(spec, { exact: true }), page.getByLabel(spec), page.locator(spec)];
}

/**
 * Waits (bounded by `timeoutMs`) until a login field is visible: any candidate from the user list or
 * the password list. A client-rendered form (an SPA that mounts after load) therefore gets its chance
 * before the "no username field" verdict. A timeout (or a candidate selector that is not CSS) is
 * swallowed, so the existing field-not-found errors are still what the operator sees.
 */
async function waitForLoginField(page: Page, login: PersonaLogin, timeoutMs: number): Promise<void> {
  const candidates = [
    ...(login.userField === undefined ? userCandidates(page) : fieldBySpec(page, login.userField)),
    ...(login.passwordField === undefined ? passwordCandidates(page) : fieldBySpec(page, login.passwordField)),
  ];
  try {
    await candidates
      .map((c) => c.filter({ visible: true }))
      .reduce((a, b) => a.or(b))
      .first()
      .waitFor({ state: "visible", timeout: timeoutMs });
  } catch {
    // No field appeared within the bound (or a candidate was not a valid selector): the lookups below decide.
  }
}

function userCandidates(page: Page): Locator[] {
  return [
    page.locator(`${TEXT_INPUT}[autocomplete~="username"]`),
    page.locator('input[type="email"]'),
    page.locator(`${TEXT_INPUT}[autocomplete~="email"]`),
    page.locator(`${TEXT_INPUT}[name*="user" i], ${TEXT_INPUT}[id*="user" i]`),
    page.locator(`${TEXT_INPUT}[name*="email" i], ${TEXT_INPUT}[id*="email" i]`),
    page.locator(`${TEXT_INPUT}[name*="login" i], ${TEXT_INPUT}[id*="login" i]`),
    page.getByLabel(/e-?mail|user\s*name|user\s*id|login|account/i),
    page.locator(`form:has(${VISIBLE_PASSWORD}) ${TEXT_INPUT}`),
  ];
}

function passwordCandidates(page: Page): Locator[] {
  return [page.locator('input[type="password"][autocomplete~="current-password"]'), page.locator(VISIBLE_PASSWORD)];
}

async function submitLocator(page: Page, spec: string | undefined): Promise<Locator | undefined> {
  if (spec !== undefined) {
    const named = await firstVisible([page.getByRole("button", { name: spec, exact: true }), page.getByRole("button", { name: spec })]);
    if (named === undefined) throw new LoginFailedError(`no visible button named ${JSON.stringify(spec)} on the sign-in page`);
    return named;
  }
  return firstVisible([
    page.locator(`form:has(${VISIBLE_PASSWORD}) [type="submit"]`),
    page.locator(`form:has(${TEXT_INPUT}) [type="submit"]`),
    page.getByRole("button", { name: /^\s*(log\s*-?\s*in|sign\s*-?\s*in|continue|next|submit)\b/i }),
  ]);
}

/** Refuses to type anything into a page whose origin the run does not authorize. */
function assertPageAuthorized(page: Page, allowlist: readonly string[]): void {
  try {
    assertAuthorizedExploreTarget(page.url(), allowlist);
  } catch (err) {
    if (!(err instanceof UnauthorizedExploreTargetError)) throw err;
    throw new LoginFailedError(`the sign-in page is on ${originOf(page.url())}, which is not an authorized origin (allowed: ${allowlist.join(", ") || "<none>"}) — credentials are never typed there; pass --allow <origin> to authorize it`);
  }
}

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "?";
  }
}

function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return "?";
  }
}

/** How often {@link waitForNoSignInForm} re-checks the page for sign-in-form evidence (clock time). */
const SIGN_IN_FORM_POLL_MS = 100;

/** The submit controls whose accessible name marks a form as a sign-in form. */
const SIGN_IN_BUTTON = /sign\s*in|log\s*in|login|continue/i;

/**
 * True when the page shows evidence of a sign-in form (#442): a login-like URL, OR a visible password
 * field together with a visible username/email field ({@link userCandidates}) or a visible button whose
 * accessible name matches {@link SIGN_IN_BUTTON}. A page with only a password field (an API-credentials
 * or settings form) is NOT a sign-in form — it is not evidence of an expired session.
 */
async function showsSignInForm(page: Page): Promise<boolean> {
  if (isLoginLikeUrl(page.url())) return true;
  if ((await page.locator(VISIBLE_PASSWORD).filter({ visible: true }).count().catch(() => 0)) === 0) return false;
  if ((await firstVisible(userCandidates(page))) !== undefined) return true;
  return (await firstVisible([page.getByRole("button", { name: SIGN_IN_BUTTON })])) !== undefined;
}

/**
 * Waits until {@link showsSignInForm} is false, bounded by `timeoutMs` of clock time (polled on the
 * injectable clock, never a real-time sleep). Throws a Playwright-shaped `TimeoutError` at the bound,
 * so the caller's existing timeout handling reports the login as failed.
 */
async function waitForNoSignInForm(page: Page, timeoutMs: number): Promise<void> {
  const deadline = clock.now() + Math.max(0, timeoutMs);
  for (;;) {
    if (!(await showsSignInForm(page))) return;
    const left = deadline - clock.now();
    if (left <= 0) {
      const err = new Error(`Timeout ${Math.round(timeoutMs)}ms exceeded waiting for the page to leave its sign-in form`);
      err.name = "TimeoutError";
      throw err;
    }
    await clock.sleep(Math.min(SIGN_IN_FORM_POLL_MS, left));
  }
}

async function waitForSuccess(page: Page, success: LoginSuccess | undefined, timeoutMs: number): Promise<void> {
  if (success === undefined) {
    // Default: the app moved off its sign-in page — no login-like URL, and no sign-in-form evidence.
    await page.waitForURL((u) => !isLoginLikeUrl(u.href), { timeout: timeoutMs, waitUntil: "load" });
    await waitForNoSignInForm(page, timeoutMs);
    return;
  }
  if (success.kind === "urlIncludes") {
    await page.waitForURL((u) => u.href.includes(success.text), { timeout: timeoutMs, waitUntil: "load" });
  } else if (success.kind === "selector") {
    await page.locator(success.selector).first().waitFor({ state: "visible", timeout: timeoutMs });
  } else {
    await page.getByText(success.text).first().waitFor({ state: "visible", timeout: timeoutMs });
  }
}

/** A sign-in form's error message (an alert, or a field the page marked invalid). */
const FORM_ERROR = '[role="alert"], [aria-invalid="true"]';

/**
 * Resolves "rejected" when, after the submit, the page shows a form error while a password field is
 * still visible (the credentials were refused) — so a wrong password fails at once, not at the
 * timeout. Never resolves otherwise (the success wait decides).
 */
function formRejected(page: Page, timeoutMs: number): Promise<"rejected"> {
  const never = new Promise<never>(() => undefined);
  return page
    .locator(FORM_ERROR)
    .filter({ visible: true })
    .first()
    .waitFor({ state: "visible", timeout: timeoutMs })
    .then(
      async () => ((await page.locator(VISIBLE_PASSWORD).filter({ visible: true }).count().catch(() => 0)) > 0 ? ("rejected" as const) : never),
      () => never,
    );
}

function describeSuccess(success: LoginSuccess | undefined): string {
  if (success === undefined) return "the page to leave the sign-in form (no login-like URL, no password field)";
  if (success.kind === "urlIncludes") return `the URL to include ${JSON.stringify(success.text)}`;
  if (success.kind === "selector") return `${JSON.stringify(success.selector)} to be visible`;
  return `the text ${JSON.stringify(success.text)} to be visible`;
}

/**
 * Drives the sign-in form on `page` (already open, no storage state): navigates to `login.url`, fills
 * the fields, submits, and waits for the success check. Throws `LoginFailedError` (scrubbed).
 * Supports a two-step form (username, then a password page): when no password field is visible yet,
 * the username is submitted first.
 */
export async function performLogin(page: Page, login: PersonaLogin, secrets: LoginSecrets, opts: { readonly allowlist: readonly string[]; readonly timeoutMs: number }): Promise<string> {
  const success = login.success === undefined ? undefined : parseLoginSuccess(login.success);
  const t = opts.timeoutMs;
  try {
    if (login.url === undefined) throw new LoginFailedError("no sign-in page: the login parameters name an API endpoint, not a form");
    await page.goto(login.url, { waitUntil: "load", timeout: t });
    assertPageAuthorized(page, opts.allowlist);
    await waitForLoginField(page, login, t);
    const findUser = async (): Promise<Locator | undefined> => firstVisible(login.userField === undefined ? userCandidates(page) : fieldBySpec(page, login.userField));
    const findPassword = async (): Promise<Locator | undefined> =>
      firstVisible(login.passwordField === undefined ? passwordCandidates(page) : fieldBySpec(page, login.passwordField));
    let password = await findPassword();
    const user = await findUser();
    if (user === undefined) {
      throw new LoginFailedError(`no username field found on ${pathOf(page.url())}${login.userField === undefined ? " — name it with --user-field <label or CSS selector>" : ` matching ${JSON.stringify(login.userField)}`}`);
    }
    await user.fill(secrets.username, { timeout: t });
    if (password === undefined) {
      // Two-step sign-in: submit the username, then the password page.
      const next = await submitLocator(page, login.submit);
      if (next === undefined) await user.press("Enter", { timeout: t });
      else await next.click({ timeout: t });
      if (login.passwordField === undefined) await page.locator(VISIBLE_PASSWORD).filter({ visible: true }).first().waitFor({ state: "visible", timeout: t });
      else await page.waitForLoadState("load", { timeout: t });
      assertPageAuthorized(page, opts.allowlist);
      password = await findPassword();
    }
    if (password === undefined) {
      throw new LoginFailedError(`no password field found on ${pathOf(page.url())}${login.passwordField === undefined ? " — name it with --password-field <label or CSS selector>" : ` matching ${JSON.stringify(login.passwordField)}`}`);
    }
    assertPageAuthorized(page, opts.allowlist);
    await password.fill(secrets.password, { timeout: t });
    const submit = await submitLocator(page, login.submit);
    // An error message already on the form is not this attempt's: early failure detection is then off.
    const alertsBefore = await page.locator(FORM_ERROR).filter({ visible: true }).count().catch(() => 0);
    if (submit === undefined) await password.press("Enter", { timeout: t });
    else await submit.click({ timeout: t });
    try {
      const succeeded = waitForSuccess(page, success, t).then(() => "succeeded" as const);
      succeeded.catch(() => undefined); // awaited below, or abandoned once the form reports an error
      const outcome = alertsBefore > 0 ? await succeeded : await Promise.race([succeeded, formRejected(page, t)]);
      if (outcome === "rejected") {
        throw new LoginFailedError(`the sign-in form reported an error on ${pathOf(page.url())} — the credentials in ${login.userEnv}/${login.passwordEnv} were not accepted`);
      }
    } catch (err) {
      if (err instanceof Error && err.name === "TimeoutError") {
        throw new LoginFailedError(`the sign-in did not succeed within ${Math.round(t / 1000)}s: waited for ${describeSuccess(success)}; the page is ${pathOf(page.url())} (check the credentials in ${login.userEnv}/${login.passwordEnv}, or set --success)`);
      }
      throw err;
    }
    const landed = page.url();
    assertPageAuthorized(page, opts.allowlist);
    return landed;
  } catch (err) {
    if (err instanceof LoginFailedError) throw new LoginFailedError(scrub(err.message, secrets));
    // A Playwright error never carries a typed value, but every message is scrubbed regardless.
    const message = err instanceof Error ? err.message.split("\n")[0]! : String(err);
    throw new LoginFailedError(scrub(`the sign-in failed: ${message}`, secrets));
  }
}

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
      let ignored: boolean | undefined;
      try {
        execFileSync("git", ["check-ignore", "-q", "--no-index", "--", rel], { cwd: root, stdio: "ignore" });
        ignored = true;
      } catch (err) {
        const status = (err as { status?: number }).status;
        ignored = status === 1 ? false : undefined;
      }
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

export interface MintOptions {
  readonly login: PersonaLogin;
  /** The storage state file to write. */
  readonly save: string;
  /** Origins credentials may be typed into (the run's allowlist, the login URL's origin by default). */
  readonly allowlist: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly port: BrowserPort;
  readonly browser?: BrowserRunOptions;
  readonly timeoutMs: number;
  /**
   * #449 (an API login only): prove the new session before it is saved — the state is checked against
   * this URL with this rule (`checkSession`), and nothing is written when the check fails.
   */
  readonly verify?: { readonly url: string; readonly check: AuthCheck };
}

export interface MintResult {
  /** Absolute path of the saved storage state. */
  readonly saved: string;
  /** Where the sign-in ended (credentials and token-like query values redacted). */
  readonly landedUrl: string;
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
    const state = session.captureStorageState !== undefined ? await session.captureStorageState() : JSON.stringify(await session.page.context().storageState());
    writeStorageStateFile(save, state);
    return { saved: save, landedUrl: scrub(redactUrl(landed), secrets) };
  } catch (err) {
    if (err instanceof LoginFailedError || err instanceof LoginArgsError) throw err;
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
    throw new LoginFailedError(scrub(`the sign-in failed: ${err instanceof Error ? err.message.split("\n")[0]! : String(err)}`, secrets, token));
  } finally {
    if (tmp !== undefined) rmSync(tmp, { force: true });
    await session?.close().catch(() => undefined);
  }
}

// ── the pre-flight auth check ─────────────────────────────────────────────────────────────────

export interface SessionCheckOptions {
  readonly storageState: string;
  /** The mission's start URL. */
  readonly url: string;
  readonly allowlist: readonly string[];
  readonly check: AuthCheck;
  readonly port: BrowserPort;
  readonly browser?: BrowserRunOptions;
  readonly timeoutMs: number;
}

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

export interface EnsureSessionOptions extends Omit<SessionCheckOptions, "storageState"> {
  /** The persona's name, when the session is a persona's (it names the failure). */
  readonly persona?: string;
  readonly storageState: string;
  /** The persona's login parameters: an expired session is re-minted ONCE from them. */
  readonly login?: PersonaLogin;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** A line for the operator (stderr): a refresh happened. */
  readonly note?: (line: string) => void;
}

export type EnsureSession = { readonly ok: true; readonly refreshed: boolean } | { readonly ok: false; readonly reason: string; readonly landedUrl?: string };

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
    await mintStorageState({ login: o.login, save: o.storageState, allowlist: o.allowlist, env: o.env, port: o.port, ...(o.browser === undefined ? {} : { browser: o.browser }), timeoutMs: o.timeoutMs });
  } catch (err) {
    if (!(err instanceof LoginFailedError) && !(err instanceof LoginArgsError)) throw err;
    return { ok: false, reason: `${expired}; re-signing in ${who} failed: ${err.message}`, ...(landedUrl === undefined ? {} : { landedUrl }) };
  }
  o.note?.(`jevitate: ${who}: ${expired} — signed in again from its login parameters and saved ${basename(o.storageState)}\n`);
  const second = await checkSession(o);
  if (second.ok) return { ok: true, refreshed: true };
  return { ok: false, reason: `${second.reason} (even right after signing in again)`, landedUrl: second.landedUrl };
}

// ── the result of a run the pre-flight ended ──────────────────────────────────────────────────

/** A run the pre-flight ended (exit 2): `inconclusive`, `failure.kind: "auth-expired"` — the login page was never explored. */
export interface AuthExpiredResult {
  readonly strategy: string;
  readonly outcome: "inconclusive";
  readonly missionOutcome: "inconclusive";
  readonly reason: string;
  readonly failure: { readonly kind: "auth-expired"; readonly message: string; readonly persona?: string };
  readonly persona?: string;
  readonly startUrl: string;
  /** Where the start URL landed (token-like query values redacted). */
  readonly landedUrl?: string;
  readonly exitCode: 2;
  /** #423: a goal run's own ending (the shared `inconclusive`) and why — the run broke before it began. */
  readonly goalOutcome?: "inconclusive";
  readonly goalReason?: "broken-run";
  /** #421/#423: nothing ran, so no defect: the defect verdict is present and `none`. */
  readonly defects: readonly never[];
  readonly defectOutcome: { readonly status: "none"; readonly byKind: Readonly<Record<string, number>> };
}

export function authExpiredResult(strategy: string, startUrl: string, failed: Extract<EnsureSession, { ok: false }>, persona?: string): AuthExpiredResult {
  const reason = `${persona === undefined ? "" : `persona ${persona}: `}${failed.reason} — the mission did not start (re-save the storage state with \`jevitate login\`, or give the persona login parameters to refresh it automatically)`;
  return {
    strategy,
    outcome: "inconclusive",
    missionOutcome: "inconclusive",
    reason,
    failure: { kind: "auth-expired", message: reason, ...(persona === undefined ? {} : { persona }) },
    ...(persona === undefined ? {} : { persona }),
    startUrl: redactUrl(startUrl),
    ...(failed.landedUrl === undefined ? {} : { landedUrl: failed.landedUrl }),
    exitCode: 2,
    ...(strategy === "goal" ? { goalOutcome: "inconclusive" as const, goalReason: "broken-run" as const } : {}),
    defects: [],
    defectOutcome: { status: "none", byKind: {} },
  };
}
