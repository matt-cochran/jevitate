import { basename } from "node:path";
import { isLoginLikeUrl } from "@jevitate/explore";

/**
 * #213: was a run's `--storage-state` (a persona's) session honoured? A dead session (an expired or
 * bogus cookie) does not fail the run by itself: the app shows its sign-in form, and a goal run's
 * model may simply sign in on its own — the run then passes, silently testing as whoever it logged
 * in as, not the persona. Code-decided from the FIRST page the run decided on (its seed landing):
 * a login-like URL (the #82 pattern), or a sign-in form — a visible password field — on it.
 *
 * Returns why the session was not honoured, or undefined (no storage state given, or the first page
 * was not a sign-in page). Never a verdict about the app: a warning on the result and the summary.
 */
export function sessionLostReason(data: { readonly target?: unknown; readonly transcript?: unknown }): string | undefined {
  const target = isRecord(data.target) ? data.target : undefined;
  const state = typeof target?.storageStatePath === "string" ? target.storageStatePath : undefined;
  if (state === undefined) return undefined;
  const first = Array.isArray(data.transcript) ? data.transcript.find(isRecord) : undefined;
  if (first === undefined) return undefined;
  const url = typeof first.url === "string" ? first.url : "";
  const controls = Array.isArray(first.controls) ? first.controls.filter((c): c is string => typeof c === "string") : [];
  const loginUrl = url !== "" && isLoginLikeUrl(url);
  const passwordField = controls.some((c) => PASSWORD_CONTROL.test(c));
  if (!loginUrl && !passwordField) return undefined;
  const where = pathOf(url);
  const what = loginUrl ? `the first page was a sign-in page (${where})` : `the first page (${where}) showed a sign-in form (a password field)`;
  return `the session in ${basename(state)} was not honoured — ${what}; the run did not start signed in as that session (re-save the storage state, or check its cookie is still valid)`;
}

/** A password field's control identity (`textbox "Password"`, `textbox "Passcode"`, …). */
const PASSWORD_CONTROL = /^(?:textbox|searchbox)\s+"[^"]*\b(?:password|passcode|passwort|mot de passe)\b[^"]*"$/i;

function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url === "" ? "?" : url;
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
