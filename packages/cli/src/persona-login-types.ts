import { redactText, redactUrl } from "@jevitate/ai-core";
import { assertAuthorizedExploreTarget, UnauthorizedExploreTargetError } from "@jevitate/explore";
import type { BrowserPort } from "@jevitate/playwright";
import type { Page } from "playwright";
import type { BrowserRunOptions } from "./browser-run-options.js";

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
  /** #741: the organization selection control (a label, else a CSS selector). Default: found by label/role. */
  readonly organizationField?: string;
  /** #741: the role selection control (a label, else a CSS selector). Default: found by label/role. */
  readonly roleField?: string;
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

/** #741: the persona's declared organization/role could not be selected and asserted. */
export class LoginContextError extends Error {
  readonly code = "E_LOGIN_CONTEXT" as const;
  constructor(message: string) {
    super(message);
    this.name = "LoginContextError";
  }
}


/** #741: a declared organization/role a login must select (and prove) before the state is captured. */
export interface LoginContext {
  readonly organization?: string;
  readonly role?: string;
}

/** The names an API login's settings go by in error messages (flags, or a personas file's `login.api.*`). */
export interface ApiLoginLabels {
  readonly url: string;
  readonly userKey: string;
  readonly passwordKey: string;
  readonly tokenPath: string;
  readonly storageKey: string;
  readonly storage: string;
  readonly verifyUrl: string;
}

export const FLAG_LABELS: ApiLoginLabels = {
  url: "--api",
  userKey: "--api-user-key",
  passwordKey: "--api-password-key",
  tokenPath: "--token-path",
  storageKey: "--storage-key",
  storage: "--storage",
  verifyUrl: "--verify-url",
};

export type LoginSuccess =
  | { readonly kind: "urlIncludes"; readonly text: string }
  | { readonly kind: "selector"; readonly selector: string }
  | { readonly kind: "text"; readonly text: string };

export type AuthCheck =
  | { readonly mode: "off" }
  | { readonly mode: "auto" }
  | { readonly mode: "urlExcludes"; readonly text: string }
  | { readonly mode: "selector"; readonly selector: string };

export interface LoginSecrets {
  readonly username: string;
  readonly password: string;
}

/** Removes both credentials, and any session token read (#449), (and URL credentials/tokens) from a text before it leaves this module. */
export function scrub(text: string, secrets: LoginSecrets, token?: string): string {
  return redactText(text, token === undefined ? [secrets.password, secrets.username] : [token, secrets.password, secrets.username]);
}

/** Refuses to type anything into a page whose origin the run does not authorize. */
export function assertPageAuthorized(page: Page, allowlist: readonly string[]): void {
  try {
    assertAuthorizedExploreTarget(page.url(), allowlist);
  } catch (err) {
    if (!(err instanceof UnauthorizedExploreTargetError)) throw err;
    throw new LoginFailedError(`the sign-in page is on ${originOf(page.url())}, which is not an authorized origin (allowed: ${allowlist.join(", ") || "<none>"}) — credentials are never typed there; pass --allow <origin> to authorize it`);
  }
}

export function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "?";
  }
}

export function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return "?";
  }
}

export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
   * #741: the persona's declared organization/role. When set, the login selects each on the app
   * page and asserts the selection before capturing the storage state; an unavailable value fails
   * with `E_LOGIN_CONTEXT` and writes nothing.
   */
  readonly context?: LoginContext;
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

export interface EnsureSessionOptions extends Omit<SessionCheckOptions, "storageState"> {
  /** The persona's name, when the session is a persona's (it names the failure). */
  readonly persona?: string;
  readonly storageState: string;
  /** The persona's login parameters: an expired session is re-minted ONCE from them. */
  readonly login?: PersonaLogin;
  /** #741: the persona's declared organization/role, selected and asserted on a re-mint. */
  readonly context?: LoginContext;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** A line for the operator (stderr): a refresh happened. */
  readonly note?: (line: string) => void;
}

export type EnsureSession = { readonly ok: true; readonly refreshed: boolean } | { readonly ok: false; readonly reason: string; readonly landedUrl?: string };

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
