/**
 * #334: native dialogs (`window.alert` / `confirm` / `prompt`, `beforeunload`) raised while the run
 * acts. With nobody listening, Playwright silently dismisses every one: a confirm-gated action
 * ("Revoke consent?") never sends its request and the run never learns why. A run that installs a
 * policy here (the goal loop does, from its `SafetyPolicy`) has each dialog raised during an action
 * accepted or dismissed by that policy and logged, and the log is drained into the model's history
 * and the transcript after the action.
 *
 * Only the dialogs raised DURING an action are handled here: `reloadPage` keeps its own listener
 * (it accepts a reload's `beforeunload` prompt), and with no policy installed nothing changes.
 */
import type { Dialog, Page } from "playwright";
import type { DialogVerdict } from "./safety.js";

/** One native dialog the run answered. */
export interface NativeDialogEvent {
  readonly type: string;
  /** The dialog's message (redacted by the transcript like any other text). */
  readonly message: string;
  readonly action: "accepted" | "dismissed";
  readonly why: string;
}

/** Decides one dialog. */
export type DialogDecider = (d: { readonly type: string; readonly message: string }) => DialogVerdict;

/** A dialog's message as logged: one line, bounded. */
const MESSAGE_MAX_CHARS = 300;

interface Installed {
  readonly decide: DialogDecider;
  readonly events: NativeDialogEvent[];
}

const installed = new WeakMap<Page, Installed>();

/** Installs the run's dialog policy on `page` (replacing an earlier one). */
export function installDialogPolicy(page: Page, decide: DialogDecider): void {
  installed.set(page, { decide, events: [] });
}

/** The dialogs answered since the last call (oldest first), and clears the log. */
export function takeDialogEvents(page: Page): NativeDialogEvent[] {
  const i = installed.get(page);
  if (i === undefined || i.events.length === 0) return [];
  return i.events.splice(0, i.events.length);
}

/**
 * Runs `action` with the page's dialog policy answering every native dialog it raises. Without an
 * installed policy it just runs `action` (Playwright's default: dismiss).
 */
export async function withDialogPolicy<T>(page: Page, action: () => Promise<T>): Promise<T> {
  const i = installed.get(page);
  if (i === undefined) return action();
  const onDialog = (dialog: Dialog): void => {
    const type = dialog.type();
    const message = dialog.message().replace(/\s+/g, " ").trim().slice(0, MESSAGE_MAX_CHARS);
    const verdict = i.decide({ type, message });
    i.events.push({ type, message, action: verdict.action === "accept" ? "accepted" : "dismissed", why: verdict.why });
    // A dialog already answered (another listener, a closed page) is not this run's failure.
    void (verdict.action === "accept" ? dialog.accept() : dialog.dismiss()).catch(() => undefined);
  };
  page.on("dialog", onDialog);
  try {
    return await action();
  } finally {
    page.off("dialog", onDialog);
  }
}

/** The history line the model sees for one answered dialog. */
export function dialogHistoryLine(e: NativeDialogEvent): string {
  return `a native ${e.type} dialog appeared ("${e.message}") and was ${e.action}: ${e.why}`;
}
