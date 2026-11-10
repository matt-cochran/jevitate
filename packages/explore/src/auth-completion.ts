import type { Control, Snapshot } from "./snapshot.js";
import { isLoginLikeUrl } from "./seed-redirect.js";
import type { PageStatus } from "./status.js";

/**
 * Code-observed sign-in completion (#188 item 4).
 *
 * A usability review has no independent success check, so "done" rests on grounding. A goal like
 * "Sign in … and complete two-factor authentication" ended `blocked`/incomplete although the run had
 * typed the password and the code, left `/login` for `/`, and the page showed the signed-in app
 * ("Account: …", a credit chip): the goal judgment only ever saw that page's text, which never says
 * "you are signed in", and a model `blocked` was accepted without asking whether the goal was met.
 *
 * What code can observe, with no model: the run itself TYPED into a credential field (a password,
 * a one-time/verification code, or a bound secret field), and now the page is not a sign-in page,
 * shows no credential field and no sign-in control, and shows signed-in chrome (a sign-out or
 * account/profile control) — or (0.30.0 nav lab `sign-in-goal`) it is a page that offered a sign-in
 * control before the run typed credentials and no longer does (a home page whose "Sign in" link gave
 * way to the signed-in app, with no sign-out shown), unless the page shows a sign-in error: an alert
 * (`role=alert`, `aria-live=assertive`), an invalid field, or a notice or line of text that says the
 * sign-in failed ("Incorrect email or password", "try again"). An app whose home page drops its Sign-in
 * link and shows an error banner after a wrong password has not signed anyone in. That is evidence — shown to the goal judgment as a code-observed fact and
 * weighed by `groundDone` — never a verdict about a goal that asks for more than signing in.
 */

/** A one-time / verification code field, by its accessible name. */
const OTP_NAME =
  /\b(?:one[- ]?time|verification|authentication|authenticator|security|login|sign[- ]?in|2fa|mfa|two[- ]?factor|otp|totp)\b[^]*\bcode\b|\b(?:otp|totp|passcode|2fa code|mfa code)\b/i;

/** A control that starts signing in — its presence means this page is not signed in. */
const SIGN_IN_CONTROL = /^\s*(?:sign|log)[- ]?in\b|^\s*login\b/i;

/** Signed-in chrome: a control only an authenticated session shows. */
const SIGNED_IN_CONTROL =
  /\b(?:sign|log)[- ]?out\b|\blogout\b|\bsignout\b|^\s*(?:my\s+)?account\b|\buser\s+menu\b|^\s*(?:my\s+)?profile\b|\baccount\s+(?:menu|settings)\b/i;

const TEXT_ENTRY_ROLES = new Set(["textbox", "searchbox", "spinbutton"]);

/** Words a failed sign-in's message uses. */
const LOGIN_ERROR = /\b(?:invalid|incorrect|wrong\s+(?:password|email|username|credentials?)|try\s+again|failed|unsuccessful|not\s+recogni[sz]ed|(?:does|did)\s*n[o']?t\s+match|locked)\b/i;
/** What a failed sign-in's message is about: a line of page text says so only when it names one. */
const LOGIN_NOUN = /\b(?:password|passcode|e-?mail|user\s?name|credentials?|account|(?:sign|log)[- ]?in|login|code)\b/i;

/** What the page shows besides its controls, read where the run perceives it: its status, and its text. */
export interface AuthPageEvidence {
  /** The page's live-region and invalid-field status (`readPageStatus`). */
  readonly status?: PageStatus | undefined;
  /** The page's visible text (`readPageText`), one line per block. */
  readonly text?: string | undefined;
}

/**
 * True when the page shows a sign-in error: any alert or invalid field, a notice with a failure's
 * words, or a line of text with a failure's words about a credential ("Incorrect email or password.").
 */
export function showsLoginError(evidence: AuthPageEvidence): boolean {
  const status = evidence.status;
  if (status !== undefined && (status.alerts.length > 0 || status.invalid.length > 0 || status.notices.some((n) => LOGIN_ERROR.test(n)))) return true;
  return (evidence.text ?? "").split(/\n+/).some((line) => LOGIN_ERROR.test(line) && LOGIN_NOUN.test(line));
}

/** True for a password field or a one-time/verification-code field. */
export function isCredentialField(c: Control): boolean {
  if (c.inputType === "password") return true;
  const textEntry = c.tag === "input" || c.tag === "textarea" || TEXT_ENTRY_ROLES.has(c.role);
  return textEntry && OTP_NAME.test(c.name);
}

/** The first control on the page that only a signed-in session shows, or null. */
export function signedInChrome(controls: readonly Control[]): Control | null {
  return controls.find((c) => c.name !== "" && SIGNED_IN_CONTROL.test(c.name) && !isCredentialField(c)) ?? null;
}

/** What code observed about sign-in on the current page, for a run that typed credentials. */
export interface AuthSignal {
  /** Every completion signal holds: see `AuthProgress.signal`. */
  readonly completed: boolean;
  /** The code-observed facts, one line — safe to show a judgment (control names only; redacted downstream). */
  readonly facts: string;
}

const pathOf = (url: string): string => {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
};

/** Tracks the run's own sign-in steps and reads the completion signals on each page state. */
export class AuthProgress {
  /** Paths where the run typed into a credential field (in order of first typing). */
  readonly #typedOn: string[] = [];
  /** Non-sign-in paths that showed a sign-in control before the run typed any credential. */
  readonly #offeredSignInOn = new Set<string>();

  /**
   * Notes an action the run performed. Only a SUCCESSFUL `type`/`send` into a credential field — or a
   * bound secret field (`bound`) — counts: a sign-in the run never attempted proves nothing.
   */
  noteTyped(control: Control | null, url: string, ok: boolean, bound: boolean): void {
    if (!ok || control === null) return;
    if (!bound && !isCredentialField(control)) return;
    const p = pathOf(url);
    if (!this.#typedOn.includes(p)) this.#typedOn.push(p);
  }

  /** True once the run typed into a credential field. */
  get attempted(): boolean {
    return this.#typedOn.length > 0;
  }

  /**
   * The sign-in completion signals on `snap`, or null when the run never typed credentials.
   * `completed` needs ALL of: the page is not login-like and is not a page the run typed credentials
   * on; no credential field (`isBound` included) and no sign-in control is shown; signed-in chrome is,
   * or this page offered a sign-in control before the run's first credential and now offers none.
   * The sign-in control having gone never counts while the page shows a sign-in error (`showsLoginError`
   * on `evidence`). Called on every page state: before the first credential it only notes which pages offer sign-in.
   */
  signal(snap: Snapshot, isBound: (c: Control) => boolean = () => false, evidence: AuthPageEvidence = {}): AuthSignal | null {
    const path = pathOf(snap.url);
    const signIn = snap.controls.find((c) => c.role !== "textbox" && SIGN_IN_CONTROL.test(c.name)) ?? null;
    if (!this.attempted) {
      if (signIn !== null && !isLoginLikeUrl(snap.url)) this.#offeredSignInOn.add(path);
      return null;
    }
    const leftLogin = !isLoginLikeUrl(snap.url) && !this.#typedOn.includes(path);
    const credential = snap.controls.find((c) => isCredentialField(c) || isBound(c)) ?? null;
    const chrome = signedInChrome(snap.controls);
    // The same page, signed out before and now without its sign-in control: the app changed it for this session.
    // ...unless the page says the sign-in failed (an error banner where the Sign-in link was).
    const offeredBefore = signIn === null && this.#offeredSignInOn.has(path);
    const loginError = offeredBefore && showsLoginError(evidence);
    const signInGone = offeredBefore && !loginError;
    const completed = leftLogin && credential === null && signIn === null && (chrome !== null || signInGone);
    const where = this.#typedOn.join(", ");
    const facts = [
      `the run typed sign-in credentials on ${where}`,
      leftLogin ? `this page (${path}) is a different, non-sign-in page` : `this page (${path}) is still a sign-in page`,
      credential === null ? "no password or verification-code field is shown" : `a credential field is still shown ("${credential.name}")`,
      signIn === null ? null : `a sign-in control is shown ("${signIn.name}")`,
      chrome === null ? "no signed-in control (sign out, account, profile) is shown" : `a signed-in control is shown ("${chrome.name}")`,
      signInGone ? `this page showed a sign-in control before the run signed in and shows none now` : null,
      loginError ? "this page shows a sign-in error (an alert, an invalid field, or a message that the sign-in failed)" : null,
    ]
      .filter((f): f is string => f !== null)
      .join("; ");
    return { completed, facts };
  }
}
