import type { DoneReading } from "@jevitate/adjudicator";
import { doneCheckScope, isDoneCheckIssues, parseDoneCheck, type DoneCheckSpec, type Journey } from "@jevitate/journey";
import { loadCatalog } from "./catalog-api.js";
import { linkedJobDone, type JobDoneView } from "./catalog-refs.js";
import { PlaywrightDoneCheckPort } from "./journey-done-check-hook.js";
import { readDoneCheck, type BrowserPort, type DoneCheckAuth, type ReadDoneCheckInput } from "./journey-done-check.js";

/**
 * #795 (design 0.30.0 §3.1 "Reconcile"): before a retry (`journey run --retry`) or a resume
 * (`inbox resume`) of an automation run, the linked job's done check is read first, in a FRESH
 * context. A check that already reads true means the job happened, and repeating its writes would
 * duplicate them, so the retry does not run and the result says why. One contract (the done check),
 * not a prepare/commit/reconcile protocol; each write's receipt is its `WriteShape` evidence entry.
 *
 * A job with NO done check (no linked job, or a job without `done`) proceeds exactly as before:
 * reconcile has nothing to read, so it neither blocks nor claims anything.
 *
 * No param or extract value reaches a result or a message: they are code-templated text only.
 */

type ReconcileCode = "E_RECONCILE_ALREADY_DONE" | "E_RECONCILE_UNREADABLE";

export type ReconcileResult =
  | { readonly proceed: true }
  | { readonly proceed: false; readonly basis: "already-true"; readonly code: "E_RECONCILE_ALREADY_DONE"; readonly message: string }
  | { readonly proceed: false; readonly basis: "reading-unknown"; readonly code: "E_RECONCILE_UNREADABLE"; readonly message: string };

export const RECONCILE_ALREADY_DONE_MESSAGE =
  "the job's done check already reads true in a fresh session: the job happened, so the retry does not run (repeating its writes would duplicate them)";
export const RECONCILE_UNREADABLE_MESSAGE =
  "the job's done check could not be read in a fresh session, so whether the job already happened is unknown: the retry does not run (repeating its writes could duplicate them)";

export interface ReconcileInput {
  readonly journey: Journey;
  /** The job the Journey links, with its done check (`linkedJobDone`); undefined or without `done`: proceed. */
  readonly job: JobDoneView | undefined;
  readonly auth: DoneCheckAuth;
  /** The target origin; default the Journey's recorded site. */
  readonly origin?: string | undefined;
  /** The run's params; only the non-secret names the check can bind are used. */
  readonly params?: Readonly<Record<string, string>> | undefined;
  /** The fresh-context browser (default: Playwright, seeded from `auth`). */
  readonly browserPort?: BrowserPort | undefined;
  /** Testing seam: the reader (default `readDoneCheck`). */
  readonly read?: ((input: ReadDoneCheckInput) => Promise<DoneReading>) | undefined;
}

/** Reads the job's done check in a fresh context and decides whether a retry or resume may run. */
export async function reconcileBeforeRetry(input: ReconcileInput): Promise<ReconcileResult> {
  // No done check: nothing to reconcile against, so the retry proceeds as before.
  if (input.job?.done === undefined) return { proceed: true };
  const origin = input.origin ?? input.journey.recording.site;
  const parsed = parseDoneCheck(input.job.done, doneCheckScope(input.journey));
  // A check the lint refuses is never read; whether the job happened is unknown.
  if (isDoneCheckIssues(parsed)) return unreadable();
  const spec: DoneCheckSpec = parsed;
  const bound = new Set(doneCheckScope(input.journey).bound);
  const params: Record<string, string> = {};
  for (const [k, v] of Object.entries(input.params ?? {})) if (bound.has(k) && !v.includes("${")) params[k] = v;
  let reading: DoneReading;
  try {
    reading = await (input.read ?? readDoneCheck)({
      spec,
      origin,
      auth: input.auth,
      params,
      extracts: {},
      browserPort: input.browserPort ?? new PlaywrightDoneCheckPort({ origin }),
      at: "pre",
    });
  } catch {
    return unreadable();
  }
  if (!reading.value.known) return unreadable();
  return reading.value.value ? { proceed: false, basis: "already-true", code: "E_RECONCILE_ALREADY_DONE", message: RECONCILE_ALREADY_DONE_MESSAGE } : { proceed: true };
}

function unreadable(): ReconcileResult {
  return { proceed: false, basis: "reading-unknown", code: "E_RECONCILE_UNREADABLE", message: RECONCILE_UNREADABLE_MESSAGE };
}

export interface ReconcileLinkedInput extends Omit<ReconcileInput, "job"> {
  readonly catalogDir: string | null;
  readonly journeysDir: string;
}

/** The call sites' entry: finds the Journey's linked job in the catalog, then reconciles. An unreadable catalog is no check. */
export async function reconcileLinkedJob(input: ReconcileLinkedInput): Promise<ReconcileResult> {
  let job: JobDoneView | undefined;
  try {
    job = linkedJobDone(await loadCatalog(input.catalogDir, input.journeysDir), input.journey);
  } catch {
    job = undefined;
  }
  return reconcileBeforeRetry({ ...input, job });
}
