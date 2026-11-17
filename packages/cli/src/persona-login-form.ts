import { clock } from "@jevitate/domain";
import { DESTRUCTIVE, isLoginLikeUrl, SESSION_END } from "@jevitate/explore";
import type { Locator, Page } from "playwright";
import { parseLoginSuccess } from "./persona-login-parse.js";
import { assertPageAuthorized, escapeRegExp, LoginContextError, LoginFailedError, pathOf, scrub, type LoginContext, type LoginSecrets, type LoginSuccess, type PersonaLogin } from "./persona-login-types.js";

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
export async function showsSignInForm(page: Page): Promise<boolean> {
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

/** The label a context control is found by when the login config does not name one. */
const CONTEXT_CONTROL_LABEL: Readonly<Record<"organization" | "role", RegExp>> = {
  organization: /organization|organisation|\borg\b|workspace|tenant|account/i,
  role: /\brole\b/i,
};

/** #741: the roles a Choose-Your-Workspace chooser renders its cards as (not a `<select>`). */
const CHOOSER_ROLES = ["button", "link", "option", "radio"] as const;
/** How long the chooser path waits for the click to settle (load + quiet network). */
const CHOOSER_SETTLE_MS = 3_000;

/** The visible, enabled chooser elements whose accessible name matches (Playwright's name matching). */
async function chooserMatches(page: Page, name: string | RegExp, exact = false): Promise<Locator[]> {
  const out: Locator[] = [];
  const query = exact && typeof name === "string" ? { name, exact: true } : { name };
  for (const role of CHOOSER_ROLES) {
    const found = page.getByRole(role, query).filter({ visible: true });
    const count = await found.count().catch(() => 0);
    for (let i = 0; i < count; i++) {
      const item = found.nth(i);
      if (await item.isEnabled().catch(() => true)) out.push(item);
    }
  }
  return out;
}

/** The names of every visible, enabled chooser card (for an error message that says what was offered). */
async function chooserOffered(page: Page): Promise<string[]> {
  const names: string[] = [];
  for (const role of CHOOSER_ROLES) {
    const found = page.getByRole(role).filter({ visible: true });
    const count = await found.count().catch(() => 0);
    for (let i = 0; i < count; i++) {
      const item = found.nth(i);
      if (!(await item.isEnabled().catch(() => true))) continue;
      const name = (await item.evaluate((el) => (el.getAttribute("aria-label") ?? el.textContent ?? "").replace(/\s+/g, " ").trim()).catch(() => "")) || "";
      names.push(name);
    }
  }
  return names;
}

/**
 * The visible, enabled chooser cards whose accessible name is exactly `value`, else contains it as a
 * whole word. A whole-word match never selects a session-ending or destructive control ("Remove
 * Admin" for the role "Admin"): only an exact name may.
 */
async function chooserCandidates(page: Page, value: string): Promise<Locator[]> {
  const exact = await chooserMatches(page, value, true);
  if (exact.length > 0) return exact;
  const loose = await chooserMatches(page, new RegExp(`\\b${escapeRegExp(value)}\\b`, "i"));
  const safe: Locator[] = [];
  for (const card of loose) {
    const name = (await card.evaluate((el) => (el.getAttribute("aria-label") ?? el.textContent ?? "").replace(/\s+/g, " ").trim()).catch(() => "")) || "";
    if (!SESSION_END.test(name) && !DESTRUCTIVE.test(name)) safe.push(card);
  }
  return safe;
}

/**
 * #741: a Choose-Your-Workspace chooser renders the organization/role as visible cards (a button,
 * link, option or radio) rather than a `<select>`. Find exactly ONE card named `value` (exact, else
 * a whole-word match), click it, wait for the page to settle, and prove the card is gone (or the URL
 * changed) before the storage state is captured. Zero or several cards fail with `E_LOGIN_CONTEXT`,
 * naming what the chooser offered.
 */
async function selectContextCard(page: Page, what: "organization" | "role", value: string, timeoutMs: number): Promise<void> {
  const before = page.url();
  const matches = await chooserCandidates(page, value);
  if (matches.length === 0) {
    const offered = await chooserOffered(page);
    throw new LoginContextError(`the declared ${what} ${JSON.stringify(value)} is unavailable on ${pathOf(before)}: the chooser offers ${offered.length === 0 ? "nothing" : offered.map((n) => JSON.stringify(n)).join(", ")}`);
  }
  if (matches.length > 1) {
    const offered = await Promise.all(matches.map(async (m) => (await m.evaluate((el) => (el.getAttribute("aria-label") ?? el.textContent ?? "").replace(/\s+/g, " ").trim()).catch(() => "")) || ""));
    throw new LoginContextError(`the declared ${what} ${JSON.stringify(value)} is ambiguous on ${pathOf(before)}: ${matches.length} chooser cards match (${offered.map((n) => JSON.stringify(n)).join(", ")})`);
  }
  await matches[0]!.click({ timeout: timeoutMs });
  // Let a client-side navigation finish: the page load, then a quiet network.
  await page.waitForLoadState("load", { timeout: timeoutMs }).catch(() => undefined);
  await page.waitForLoadState("networkidle", { timeout: Math.min(timeoutMs, CHOOSER_SETTLE_MS) }).catch(() => undefined);
  if (page.url() !== before) return;
  if ((await chooserCandidates(page, value)).length > 0) {
    throw new LoginContextError(`the declared ${what} ${JSON.stringify(value)} was clicked on ${pathOf(page.url())}, but the chooser still offers it — the selection did not take`);
  }
}

/**
 * #741: selects each declared context value on the app page and asserts the control actually took
 * it. Called after the sign-in and BEFORE the storage state is captured. A declared value the app
 * does not offer throws {@link LoginContextError} (`E_LOGIN_CONTEXT`), so nothing is written.
 */
export async function selectLoginContext(page: Page, context: LoginContext, opts: { readonly login: Pick<PersonaLogin, "organizationField" | "roleField">; readonly timeoutMs: number }): Promise<void> {
  await selectContextValue(page, "organization", context.organization, opts.login.organizationField, opts.timeoutMs);
  await selectContextValue(page, "role", context.role, opts.login.roleField, opts.timeoutMs);
}

async function selectContextValue(page: Page, what: "organization" | "role", value: string | undefined, field: string | undefined, timeoutMs: number): Promise<void> {
  if (value === undefined || value === "") return;
  const candidates = field === undefined ? [page.getByLabel(CONTEXT_CONTROL_LABEL[what]), page.getByRole("combobox", { name: CONTEXT_CONTROL_LABEL[what] })] : fieldBySpec(page, field);
  const control = await firstVisible(candidates);
  if (control === undefined) {
    // #741: no labelled select/combobox and no configured field — this may be a card chooser.
    if (field !== undefined) throw new LoginContextError(`the declared ${what} ${JSON.stringify(value)} is unavailable: no ${what} control on ${pathOf(page.url())} matching ${JSON.stringify(field)}`);
    await selectContextCard(page, what, value, timeoutMs);
    return;
  }
  const labels = await control.evaluate((el: HTMLSelectElement) => (el.tagName === "SELECT" ? Array.from(el.options).map((o) => (o.textContent ?? "").trim()) : null)).catch(() => undefined);
  if (labels == null) {
    // A custom (non-`<select>`) control: open it and choose the option by its accessible name.
    await control.click({ timeout: timeoutMs });
    const option = page.getByRole("option", { name: value, exact: true }).first();
    const visible = await option
      .waitFor({ state: "visible", timeout: timeoutMs })
      .then(() => true)
      .catch(() => false);
    if (!visible) throw new LoginContextError(`the declared ${what} ${JSON.stringify(value)} is unavailable on ${pathOf(page.url())}: the ${what} control does not offer it`);
    await option.click({ timeout: timeoutMs });
    return;
  }
  if (!labels.includes(value)) {
    throw new LoginContextError(`the declared ${what} ${JSON.stringify(value)} is unavailable on ${pathOf(page.url())}: the ${what} control offers ${labels.length === 0 ? "nothing" : labels.map((l) => JSON.stringify(l)).join(", ")}`);
  }
  await control.selectOption({ label: value }, { timeout: timeoutMs });
  const selected = await control.evaluate((el: HTMLSelectElement) => el.selectedOptions[0]?.textContent?.trim() ?? null);
  if (selected !== value) {
    throw new LoginContextError(`the declared ${what} ${JSON.stringify(value)} was not selected: the ${what} control shows ${JSON.stringify(selected)}`);
  }
}
