import { clock } from "@jevitate/domain";
import { resolveDoneCheck, type DoneCheckSpec } from "@jevitate/journey";
import {
  judgeDoneCheck,
  type DoneCheckEvidence,
  type DoneReading,
  type JobVerdict,
  type UnknownReason,
} from "@jevitate/adjudicator";

/**
 * #800 (design 0.30.0 §3.1): reading a job's done check in a FRESH browser context and deciding the
 * job verdict from the before/after readings. Not yet wired into `journey run`.
 *
 * No param or extract value ever reaches an error or a reason: the only text this module produces
 * is an `UnknownReason` token, and a failure's own message is dropped (it may quote a URL).
 */

/** What a fresh context is seeded with: the run's storageState file or persona, never both required. */
export interface DoneCheckAuth {
  readonly storageState?: string;
  readonly persona?: string;
  /** The run's own context id (when known); a fresh reading must use a different one. */
  readonly runContextId?: string;
}

/** One open, isolated browser context. */
export interface DoneCheckSession {
  readonly id: string;
  navigate(url: string): Promise<void>;
  /** Evaluates a resolved `--success`-syntax check against the current page: true, false, or `unevaluable`. */
  evaluate(check: string): Promise<boolean | "unevaluable">;
  close(): Promise<void>;
}

/** The slice of the browser the done check needs; the real one wraps Playwright `newContext`. */
export interface BrowserPort {
  openContext(auth: { readonly storageState?: string; readonly persona?: string }): Promise<DoneCheckSession>;
}

export interface ReadDoneCheckInput {
  readonly spec: DoneCheckSpec;
  /** The target origin (`scheme://host[:port]`). */
  readonly origin: string;
  readonly auth: DoneCheckAuth;
  /** Non-secret params and `extract` outputs bound by the run. */
  readonly params: Readonly<Record<string, string>>;
  readonly extracts: Readonly<Record<string, string>>;
  readonly browserPort: BrowserPort;
  /** `pre` (before step 1) or `post` (after the last step); default `post`. */
  readonly at?: "pre" | "post";
}

function unknown(reason: UnknownReason, started: number, at: "pre" | "post"): DoneReading {
  return { value: { known: false, reason }, session: "fresh", at, durationMs: Math.max(0, Math.round(clock.monotonicMs() - started)) };
}

/** Opens a new context, navigates to `spec.at`, evaluates `spec.check`, always closes the context. */
export async function readDoneCheck(input: ReadDoneCheckInput): Promise<DoneReading> {
  const at = input.at ?? "post";
  const started = clock.monotonicMs();
  const values = { ...input.params, ...input.extracts };
  const resolved = resolveDoneCheck(input.spec, values, { bound: Object.keys(values) });
  if (Array.isArray(resolved)) return unknown("check-unevaluable", started, at);

  let session: DoneCheckSession | undefined;
  try {
    let url: string;
    try {
      url = new URL(resolved.at, input.origin).toString();
      if (new URL(url).origin !== new URL(input.origin).origin) return unknown("check-unevaluable", started, at);
    } catch {
      return unknown("check-unevaluable", started, at);
    }
    const { storageState, persona } = input.auth;
    try {
      session = await input.browserPort.openContext({
        ...(storageState !== undefined ? { storageState } : {}),
        ...(persona !== undefined ? { persona } : {}),
      });
      if (input.auth.runContextId !== undefined && session.id === input.auth.runContextId) return unknown("session-unavailable", started, at);
      await session.navigate(url);
    } catch {
      return unknown("session-unavailable", started, at);
    }
    let result: boolean | "unevaluable";
    try {
      result = await session.evaluate(resolved.check);
    } catch {
      return unknown("page-replaced", started, at);
    }
    if (result === "unevaluable") return unknown("check-unevaluable", started, at);
    return { value: { known: true, value: result }, session: "fresh", at, durationMs: Math.max(0, Math.round(clock.monotonicMs() - started)) };
  } finally {
    if (session !== undefined) {
      try {
        await session.close();
      } catch {
        /* a close failure cannot change a reading already taken */
      }
    }
  }
}

/** The §3.1 table over a before and an after reading (the adjudicator's `judgeDoneCheck`). */
export function evaluateJobDoneCheck(before: DoneReading | undefined, after: DoneReading | undefined): JobVerdict {
  if (before === undefined || after === undefined) return judgeDoneCheck(undefined);
  const spec: DoneCheckEvidence["spec"] = { version: 1, at: "/", check: "" };
  return judgeDoneCheck({ spec, before, after });
}
