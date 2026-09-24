import type { Page } from "playwright";
import type { GenerationPort } from "@jevitate/ai-core";
import type { MissionFailure } from "@jevitate/domain";

/**
 * The mission-side half of "a mission's outcome is a typed result, never a throw":
 *
 *  - `CrashWatch` notices a page crash / page close / browser disconnect as it happens, so an
 *    engine failure can be classified from EVIDENCE (not guessed from an error message);
 *  - `describeFailure` turns whatever was thrown into a `MissionFailure` (crash signals win);
 *  - `tryTriage` makes the defect explanation a HELPER step: when it cannot be generated the
 *    defect is still recorded, with the explanation marked `unavailable` and the reason.
 */

/** A defect's explanation — available, or explicitly unavailable with why. */
export type Triage =
  | { readonly status: "available"; readonly summary: string; readonly likelyCause: string }
  | { readonly status: "unavailable"; readonly reason: string };

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message.split("\n")[0] ?? e.message : String(e);
}

/** Chromium's own network-error code from a message (`net::ERR_CONNECTION_REFUSED` in
 *  `page.goto: net::ERR_CONNECTION_REFUSED at http://…`), or null. */
function netErrorCode(text: string): string | null {
  return /net::(ERR_[A-Z_]+)/.exec(text)?.[1] ?? null;
}

/** Plain-words phrases for the network errors seen when a target simply cannot be reached. */
const NET_ERROR_PHRASES: Readonly<Record<string, string>> = {
  ERR_CONNECTION_REFUSED: "connection refused",
  ERR_CONNECTION_RESET: "connection reset",
  ERR_CONNECTION_CLOSED: "connection closed",
  ERR_CONNECTION_TIMED_OUT: "connection timed out",
  ERR_NAME_NOT_RESOLVED: "name not resolved",
  ERR_ADDRESS_UNREACHABLE: "address unreachable",
  ERR_UNSAFE_PORT: "unsafe port",
  ERR_EMPTY_RESPONSE: "empty response",
};

/**
 * Is this failure the start URL simply not loading — a `net::ERR_*` network error, an OS-level
 * connection refusal, or a timeout before any response? Never a defect in the app under test or a
 * bug in jevitate (#128): the target was never reached at all, so nothing about ITS behaviour, or
 * jevitate's, was ever observed.
 */
export function isUnreachableTarget(message: string): boolean {
  return /net::ERR_[A-Z_]+/.test(message) || /ECONNREFUSED/i.test(message) || /Timeout \d+ms exceeded/i.test(message);
}

/**
 * A plain-words cause for a target that could not be reached (#128). `netErrorText` is real network
 * evidence (a `requestfailed` event's `errorText`) when one was observed during the attempt — it is
 * preferred over the thrown error's own message, since Playwright's `page.goto` sometimes surfaces
 * only a bare "Timeout …ms exceeded" even when the underlying cause (e.g. a refused connection) was
 * actually seen on the wire. Never fabricated: with no net-error evidence at all, a bare timeout
 * reads as "timed out before any response", not a guessed cause.
 */
export function describeUnreachable(message: string, netErrorText?: string | null): string {
  const fromNet = netErrorText === null || netErrorText === undefined ? null : netErrorCode(netErrorText) ?? netErrorCode(message);
  const code = fromNet ?? netErrorCode(message);
  if (code !== null) return NET_ERROR_PHRASES[code] ?? code;
  if (/ECONNREFUSED/i.test(netErrorText ?? "") || /ECONNREFUSED/i.test(message)) return "connection refused";
  if (/Timeout \d+ms exceeded/i.test(message)) return "timed out before any response";
  return messageOf(new Error(message));
}

/**
 * Generates the triage narrative from an already-redacted failure summary + URL (guardrail #3:
 * never raw form state). A generation failure is DATA: `{ status: "unavailable", reason }`.
 */
export async function tryTriage(
  generation: GenerationPort,
  input: { readonly failureSummary: string; readonly url: string },
): Promise<Triage> {
  try {
    const r = await generation.generate("triage.narrative", input);
    return { status: "available", summary: r.output.summary, likelyCause: r.output.likelyCause };
  } catch (e) {
    return { status: "unavailable", reason: `triage generation failed: ${messageOf(e)}` };
  }
}

/** Crash evidence observed on a page during a run. */
export interface CrashSignals {
  readonly pageCrashed: boolean;
  readonly pageClosed: boolean;
  readonly browserDisconnected: boolean;
}

/**
 * Watches one page for engine-level failures: Playwright's `crash` (renderer died — e.g. OOM),
 * `close`, and the browser's `disconnected`. Listeners attach at construction.
 */
export class CrashWatch {
  #pageCrashed = false;
  #pageClosed = false;
  #browserDisconnected = false;

  constructor(page: Page) {
    page.on("crash", () => {
      this.#pageCrashed = true;
    });
    page.on("close", () => {
      this.#pageClosed = true;
    });
    const browser = page.context().browser();
    browser?.on("disconnected", () => {
      this.#browserDisconnected = true;
    });
  }

  signals(): CrashSignals {
    return {
      pageCrashed: this.#pageCrashed,
      pageClosed: this.#pageClosed,
      browserDisconnected: this.#browserDisconnected,
    };
  }
}

/**
 * Classifies an engine failure. Crash EVIDENCE wins over the thrown message: a renderer crash
 * surfaces in Playwright as a generic "Target crashed"/"page closed" error, and the evidence is
 * what attribution needs.
 */
export function describeFailure(e: unknown, signals: CrashSignals): MissionFailure {
  const message = messageOf(e);
  const stack = e instanceof Error && e.stack !== undefined ? e.stack : undefined;
  const kind: MissionFailure["kind"] = signals.pageCrashed
    ? "page-crash"
    : signals.browserDisconnected
      ? "browser-disconnected"
      : signals.pageClosed
        ? "page-closed"
        : "exception";
  return { kind, message, ...(stack === undefined ? {} : { stack }) };
}
