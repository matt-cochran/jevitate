/**
 * Failed actions as a stuck signal (#272, #294) — independent code, never the model.
 *
 * A click that fails because something covers its target ("<p> intercepts pointer events"), or
 * because the target can never be brought into view (a closed panel translated off-screen: the
 * click times out), changes nothing on the page. The page signature can still flicker between two
 * states (the failed click scrolls the page, which changes which controls are hit-testable), so the
 * signature-based no-progress detector never fires and a run re-clicks the same two buttons for its
 * whole budget. This tracker counts what actually happened instead:
 *
 *  - a target whose action failed twice for a covered / unreachable cause is withheld from the
 *    model until an action succeeds (or the page navigates) — and the model is told why;
 *  - `MAX_FAILED_ACTIONS` failed actions in a row (whatever the targets) end the run — `blocked`
 *    naming the overlay when one covers the page, `no-progress` otherwise.
 *
 * Only a REAL attempt (`act()` ran and returned `ok: false`) counts. A refusal decided by jevitate's
 * own guards is not a failed action (see #276).
 */

/** Why an action failed, as far as progress is concerned. */
export type FailureCause = "covered" | "unreachable" | "other";

/** Failed actions in a row (no success in between) before the run stops. */
export const MAX_FAILED_ACTIONS = 5;

/** Failures of ONE target (covered / unreachable) before it is withheld from the model. */
export const SAME_TARGET_FAILURES = 2;

const COVERED = /intercepts pointer events|target obscured by/i;
const UNREACHABLE = /outside of the viewport|Timeout \d+ms exceeded|not reachable|not stable/i;

export function failureCause(reason: string): FailureCause {
  if (COVERED.test(reason)) return "covered";
  if (UNREACHABLE.test(reason)) return "unreachable";
  return "other";
}

/** What the loop should do after a failed action. */
export interface FailureVerdict {
  /** Withhold this target from the model from now on (until an action succeeds). */
  readonly withhold: boolean;
  /** A note for the model's history (null: the failure line itself says enough). */
  readonly note: string | null;
  /** The run should stop: this many failed actions in a row. */
  readonly stop: boolean;
}

export class FailedActionStreak {
  #streak: Array<{ key: string; cause: FailureCause; reason: string }> = [];
  readonly #perTarget = new Map<string, number>();
  readonly #withheld = new Set<string>();

  /** Consecutive failed actions (no success in between). */
  get consecutive(): number {
    return this.#streak.length;
  }

  /** Targets withheld from the model (control keys). */
  withheld(): ReadonlySet<string> {
    return this.#withheld;
  }

  /** The cause most of the current streak shares (the latest wins a tie); null when none. */
  dominantCause(): FailureCause | null {
    if (this.#streak.length === 0) return null;
    const counts = new Map<FailureCause, number>();
    for (const f of this.#streak) counts.set(f.cause, (counts.get(f.cause) ?? 0) + 1);
    let best: FailureCause = this.#streak[this.#streak.length - 1]!.cause;
    for (const [cause, n] of counts) if (n > (counts.get(best) ?? 0)) best = cause;
    return best;
  }

  /** The latest failure's reason, or null. */
  lastReason(): string | null {
    return this.#streak[this.#streak.length - 1]?.reason ?? null;
  }

  /** A real action on `key` (labelled `label`) failed with `reason`. */
  fail(key: string, label: string, reason: string): FailureVerdict {
    const cause = failureCause(reason);
    this.#streak.push({ key, cause, reason });
    const n = (this.#perTarget.get(key) ?? 0) + 1;
    this.#perTarget.set(key, n);
    let withhold = false;
    let note: string | null = null;
    if (cause !== "other" && n >= SAME_TARGET_FAILURES && !this.#withheld.has(key)) {
      withhold = true;
      this.#withheld.add(key);
      note =
        cause === "covered"
          ? `${label} failed ${n} times: something covers it (an open dialog or overlay) — it is not reachable now; dismiss what covers it (its Close/Cancel control) or choose another control`
          : `${label} failed ${n} times: it is not reachable (off-screen or never in view) — choose another control`;
    }
    return { withhold, note, stop: this.#streak.length >= MAX_FAILED_ACTIONS };
  }

  /** An action succeeded (or the page navigated): the streak and every withheld target are cleared. */
  succeeded(): void {
    this.#streak = [];
    this.#perTarget.clear();
    this.#withheld.clear();
  }
}

/**
 * BROWSER CODE — the name of the open dialog / overlay that covers the page, or null: the topmost
 * visible `dialog[open]` / `[role=dialog]` / `[role=alertdialog]` / `[aria-modal=true]`, named by its
 * label, else its first heading, else its role. Used to name what blocked a run (#272).
 */
export function openOverlayName(): string | null {
  const norm = (s: string | null | undefined): string => (s ?? "").replace(/\s+/g, " ").trim();
  const all = Array.from(document.querySelectorAll('dialog[open], [role="dialog"], [role="alertdialog"], [aria-modal="true"]'));
  const shown = all.filter((m) => {
    const s = window.getComputedStyle(m as HTMLElement);
    const r = (m as HTMLElement).getBoundingClientRect();
    return s.display !== "none" && s.visibility !== "hidden" && r.width > 0 && r.height > 0;
  });
  const top = shown[shown.length - 1];
  if (top === undefined) return null;
  const labelledBy = norm(top.getAttribute("aria-labelledby"))
    .split(" ")
    .filter((id) => id !== "")
    .map((id) => norm(document.getElementById(id)?.textContent))
    .join(" ");
  const label = norm(top.getAttribute("aria-label")) || labelledBy || norm(top.querySelector("h1, h2, h3, h4, legend")?.textContent);
  const kind = norm(top.getAttribute("role")) || top.tagName.toLowerCase();
  return label === "" ? kind : `${kind} "${label.slice(0, 80)}"`;
}
