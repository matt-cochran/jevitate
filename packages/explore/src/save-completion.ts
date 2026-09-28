import type { Control, Snapshot } from "./snapshot.js";
import type { PageStatus } from "./status.js";
import type { FiredWrite } from "./side-effects.js";

/**
 * Code-observed save completion (#225).
 *
 * A usability review has no independent success check, so "done" rests on grounding. A job "save a
 * bio on your profile" failed 3/3: the bio really saved and the page said "Saved", but the goal
 * judgment only ever saw the page's `innerText` — which never holds a form field's VALUE — so the
 * saved bio, displayed only in its field, was invisible to it and `done` was rejected (p 0.42).
 *
 * What code can observe, with no model: the run itself TYPED values into form fields, then clicked
 * the control that submitted them; every write that click fired finished with a 2xx (none rejected,
 * none still in flight); the page now shows a success notice ("Saved", "Changes saved") and no
 * failure; and the page still displays each value the run saved (its field, or the page text). That
 * is evidence — shown to the goal judgment as a code-observed fact and weighed by `groundDone` —
 * never a verdict about a goal that asks for more than saving the form.
 */

/** A notice that says the submitted change went through. */
const SUCCESS_NOTICE =
  /\b(?:saved|success(?:ful(?:ly)?)?|updated|submitted|created|added|sent|changes? (?:were |was |have been )?(?:saved|applied)|thank(?:s| you))\b/i;

/** A notice/alert that says it did not. Checked first: "Not saved", "Save failed" are failures. */
const FAILURE_NOTICE =
  /\b(?:error|fail(?:ed|ure)?|could ?n[o']t|unable|went wrong|try again|invalid|please (?:check|correct|fix)|not saved|required)\b/i;

const norm = (s: string): string => s.replace(/\s+/g, " ").trim().toLowerCase();

interface Typed {
  readonly label: string;
  readonly value: string;
}

/** What code observed about the run's own save on the current page. */
export interface SaveSignal {
  /** Every completion signal holds: see `SaveProgress.signal`. */
  readonly completed: boolean;
  /** The code-observed facts, one line — field labels, write routes and statuses only, never a typed value. */
  readonly facts: string;
}

/** Tracks the values the run typed and submitted, and reads the save-completion signals. */
export class SaveProgress {
  /** Typed since the last submit, by field label (the latest value wins). */
  readonly #pending = new Map<string, Typed>();
  /** What the latest submitting click sent, and the click's name. */
  #submitted: { readonly via: string; readonly values: readonly Typed[] } | null = null;
  /** A credential was typed alongside the pending values: their submit is a sign-in, never a save. */
  #signIn = false;

  /**
   * A value the run typed into a FORM field (not a message composer, never a secret or bound field —
   * the caller filters those). Its value stays in memory only, to compare against what the page shows.
   */
  noteTyped(label: string, value: string): void {
    if (value.trim() === "") return;
    this.#pending.set(norm(label), { label, value });
  }

  /** The run typed into a credential / bound secret field: the pending batch is a sign-in (./auth-completion.ts). */
  noteCredential(): void {
    this.#signIn = true;
  }

  /** A click that submits the form: what was typed is now what it sent. */
  noteSubmitClick(controlName: string): void {
    if (this.#pending.size > 0 && !this.#signIn) this.#submitted = { via: controlName, values: [...this.#pending.values()] };
    this.reset();
  }

  /** A reload / navigation threw the typed text away. */
  reset(): void {
    this.#pending.clear();
    this.#signIn = false;
  }

  /**
   * The save completion signals on `snap`, or null when the run never submitted typed values.
   * `completed` needs ALL of: the submitting click was the run's latest click and fired ≥ 1 write, and
   * every one finished 2xx; a success notice shows and no failure notice/invalid field does; and the
   * page still displays every value it saved (in a field, or in the page text).
   */
  signal(snap: Snapshot, status: PageStatus, lastClick: { readonly writes: readonly FiredWrite[] } | null, pageText: string): SaveSignal | null {
    const s = this.#submitted;
    if (s === null) return null;
    const writes = lastClick?.writes ?? [];
    const finished = writes.length > 0 && writes.every((w) => w.status !== null && w.status >= 200 && w.status < 300);
    const texts = [...status.notices, ...status.alerts];
    const failure = texts.find((t) => FAILURE_NOTICE.test(t)) ?? (status.invalid.length > 0 ? "an invalid field" : null);
    const success = failure === null ? (texts.find((t) => SUCCESS_NOTICE.test(t)) ?? null) : null;
    const text = norm(pageText);
    const shown = (t: Typed): boolean =>
      snap.controls.some((c: Control) => typeof c.value === "string" && norm(c.value) === norm(t.value)) || text.includes(norm(t.value));
    const missing = s.values.filter((t) => !shown(t)).map((t) => `"${t.label}"`);
    const completed = finished && success !== null && missing.length === 0;
    const fields = s.values.map((t) => `"${t.label}"`).join(", ");
    const writeFacts =
      writes.length === 0
        ? `clicking "${s.via}" sent no write request (or another click came after it)`
        : `clicking "${s.via}" sent ${writes.map((w) => `${w.method} ${w.path} → ${w.status ?? "still in flight"}`).join(", ")}`;
    const facts = [
      `the run typed into ${fields} and submitted them`,
      writeFacts,
      failure !== null
        ? `the page shows a failure ("${failure}")`
        : success === null
          ? "the page shows no success notice"
          : `the page shows a success notice ("${success}")`,
      missing.length === 0 ? "the page still displays every value it saved" : `the page no longer displays the value saved in ${missing.join(", ")}`,
    ].join("; ");
    return { completed, facts };
  }
}
