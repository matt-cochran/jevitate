import { describe, expect, it } from "vitest";
import { AuthProgress } from "./auth-completion.js";
import { EMPTY_STATUS } from "./status.js";
import type { Control, Snapshot } from "./snapshot.js";

/**
 * 0.30.0 nav lab `sign-in-goal`: the signed-in home page shows "Welcome back, Morgan" and an Invoices
 * link — no sign-out or account control — so code never saw the sign-in complete and the run ended
 * blocked (0/10) although the app had signed it in. A page that offered a sign-in control before the
 * run's first credential, and offers none after it, is the code-observed signal.
 */

const control = (role: string, name: string, inputType: string | null = null): Control =>
  ({ role, name, tag: role === "textbox" ? "input" : role === "link" ? "a" : "button", inputType, enabled: true }) as unknown as Control;
const snap = (path: string, controls: Control[]): Snapshot => ({ url: `http://lab.test${path}`, controls, truncated: false, signature: path });

const SIGNED_OUT_HOME = snap("/", [control("link", "Sign in")]);
const LOGIN = snap("/login", [control("textbox", "Email"), control("textbox", "Password", "password"), control("button", "Sign in")]);
const SIGNED_IN_HOME = snap("/", [control("link", "Invoices")]);

function signedInVia(first: Snapshot): AuthProgress {
  const auth = new AuthProgress();
  expect(auth.signal(first)).toBeNull();
  expect(auth.signal(LOGIN)).toBeNull();
  auth.noteTyped(LOGIN.controls[1] ?? null, LOGIN.url, true, false);
  return auth;
}

describe("sign-in completion without signed-in chrome", () => {
  it("the page that offered Sign in before the credentials offers none after: completed", () => {
    const s = signedInVia(SIGNED_OUT_HOME).signal(SIGNED_IN_HOME);
    expect(s?.completed).toBe(true);
    expect(s?.facts).toMatch(/showed a sign-in control before the run signed in and shows none now/);
  });

  it("a page the run never saw signed out, with no signed-in chrome: not completed", () => {
    const auth = signedInVia(snap("/start", [control("link", "Sign in")]));
    expect(auth.signal(SIGNED_IN_HOME)?.completed).toBe(false);
  });

  it("the same page still offering Sign in: not completed", () => {
    expect(signedInVia(SIGNED_OUT_HOME).signal(SIGNED_OUT_HOME)?.completed).toBe(false);
  });

  it("still on the sign-in page after submitting (a rejected password): not completed", () => {
    expect(signedInVia(SIGNED_OUT_HOME).signal(LOGIN)?.completed).toBe(false);
  });
});

describe("independent re-check: a dropped Sign-in link beside a login error is not a sign-in", () => {
  const banner = { ...EMPTY_STATUS, alerts: ["Incorrect email or password."] };
  it("an alert (role=alert) on the home page that dropped its Sign-in link: not completed", () => {
    const s = signedInVia(SIGNED_OUT_HOME).signal(SIGNED_IN_HOME, () => false, { status: banner, text: "Pinecrest Books\nIncorrect email or password.\nNeed help?" });
    expect(s?.completed).toBe(false);
    expect(s?.facts).toMatch(/shows a sign-in error/);
    expect(s?.facts).not.toMatch(/shows none now/);
  });

  it.each(["Incorrect email or password.", "Wrong password, try again", "Sign-in failed", "Invalid credentials"])("error text with no live region (%s): not completed", (line) => {
    expect(signedInVia(SIGNED_OUT_HOME).signal(SIGNED_IN_HOME, () => false, { status: EMPTY_STATUS, text: `Pinecrest Books\n${line}` })?.completed).toBe(false);
  });

  it("an invalid field, or an aria-live polite notice saying it failed: not completed", () => {
    expect(signedInVia(SIGNED_OUT_HOME).signal(SIGNED_IN_HOME, () => false, { status: { ...EMPTY_STATUS, invalid: [{ name: "Email", message: "x" }] } })?.completed).toBe(false);
    expect(signedInVia(SIGNED_OUT_HOME).signal(SIGNED_IN_HOME, () => false, { status: { ...EMPTY_STATUS, notices: ["Login failed"] } })?.completed).toBe(false);
  });

  it("the signed-in home page's own text (Welcome back, Invoices) still completes", () => {
    expect(signedInVia(SIGNED_OUT_HOME).signal(SIGNED_IN_HOME, () => false, { status: EMPTY_STATUS, text: "Welcome back, Morgan\nInvoices" })?.completed).toBe(true);
  });

  it("signed-in chrome (a sign-out control) still completes beside an alert", () => {
    const chrome = snap("/", [control("button", "Sign out")]);
    expect(signedInVia(SIGNED_OUT_HOME).signal(chrome, () => false, { status: banner })?.completed).toBe(true);
  });
});
