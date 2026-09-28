import type { Page } from "playwright";
import type { GenerationPort } from "@jevitate/ai-core";
import type { MissionFailure } from "@jevitate/domain";
import { pageLostReason } from "@jevitate/playwright";
import { BrowseTheWebToken, type Actor } from "@jevitate/screenplay";

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

const PROBE_PREFIX = "reachability probe: ";

/**
 * #213: fail fast when nothing is listening at the seed. Before the FIRST navigation, the session's
 * pre-flight probe (a TCP connect — see `@jevitate/playwright`'s `probeReachable`) runs; a definite
 * "connection refused" / "host not found" throws at once — an error `isUnreachableTarget` recognises
 * and `describeUnreachable` renders as the probe's own plain words ("connection refused — is the app
 * running at <origin>?") — instead of waiting out Chromium's 30s navigation timeout. A session
 * without a probe (a test double) is never probed.
 */
export async function assertSeedReachable(actor: Actor, url: string): Promise<void> {
  let probe: ((url: string) => Promise<string | null>) | undefined;
  try {
    const session = actor.ability(BrowseTheWebToken).session;
    probe = session.probeReachable?.bind(session);
  } catch {
    return;
  }
  if (probe === undefined) return;
  const reason = await probe(url);
  if (reason !== null) throw new Error(`${PROBE_PREFIX}${reason}`);
}

/**
 * Is this failure the start URL simply not loading — a `net::ERR_*` network error, an OS-level
 * connection refusal, or a timeout before any response? Never a defect in the app under test or a
 * bug in jevitate (#128): the target was never reached at all, so nothing about ITS behaviour, or
 * jevitate's, was ever observed.
 */
export function isUnreachableTarget(message: string): boolean {
  return message.startsWith(PROBE_PREFIX) || /net::ERR_[A-Z_]+/.test(message) || /ECONNREFUSED/i.test(message) || /Timeout \d+ms exceeded/i.test(message);
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
  if (message.startsWith(PROBE_PREFIX)) return message.slice(PROBE_PREFIX.length);
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
  /** #220: the page's liveness watchdog closed it — the page process stopped answering — and why. */
  readonly unresponsive?: string;
}

/**
 * Watches one page for engine-level failures: Playwright's `crash` (renderer died — e.g. OOM),
 * `close`, and the browser's `disconnected`. Listeners attach at construction.
 */
export class CrashWatch {
  #pageCrashed = false;
  #pageClosed = false;
  #browserDisconnected = false;
  readonly #page: Page;

  constructor(page: Page) {
    this.#page = page;
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
      ...unresponsiveSignal(this.#page),
    };
  }
}

function unresponsiveSignal(page: Page): { unresponsive?: string } {
  const reason = pageLostReason(page);
  return reason === undefined ? {} : { unresponsive: reason };
}

/**
 * Classifies an engine failure. Crash EVIDENCE wins over the thrown message: a renderer crash
 * surfaces in Playwright as a generic "Target crashed"/"page closed" error, and the evidence is
 * what attribution needs.
 */
export function describeFailure(e: unknown, signals: CrashSignals): MissionFailure {
  const message = messageOf(e);
  const stack = e instanceof Error && e.stack !== undefined ? e.stack : undefined;
  // #220: the liveness watchdog closed a page that stopped answering — the run ended rather than
  // idle (a `stalled` stop), and the reason says why, not the generic "page closed" it surfaced as.
  if (signals.unresponsive !== undefined && !signals.pageCrashed && !signals.browserDisconnected) {
    return { kind: "stalled", message: `${signals.unresponsive} (${message})`, ...(stack === undefined ? {} : { stack }) };
  }
  // #226: a navigation the app never answered (its server froze or went away mid-run) — the app
  // stopped responding, not the engine: a typed `target-unresponsive` ending with a plain reason, no
  // stack (nothing in jevitate failed, so there is nothing to attribute).
  if (!signals.pageCrashed && !signals.browserDisconnected && !signals.pageClosed) {
    const unresponsive = targetUnresponsiveMessage(e);
    if (unresponsive !== null) return { kind: "target-unresponsive", message: unresponsive };
  }
  const kind: MissionFailure["kind"] = signals.pageCrashed
    ? "page-crash"
    : signals.browserDisconnected
      ? "browser-disconnected"
      : signals.pageClosed
        ? "page-closed"
        : "exception";
  return { kind, message, ...(stack === undefined ? {} : { stack }) };
}

/** A Playwright navigation call (`page.goto: …`, `page.reload: …`, `frame.waitForNavigation: …`). */
const NAVIGATION_CALL = /^(?:page|frame)\.(?:goto|reload|goBack|goForward|waitForNavigation|waitForURL|waitForLoadState)\b/;

/**
 * #226: the plain-words reason when `e` is a navigation the app never answered — a navigation call
 * that timed out, or failed with a network error — else null. Names the navigated path (never its
 * query, which may carry secrets) from Playwright's call log when it has one.
 */
export function targetUnresponsiveMessage(e: unknown): string | null {
  const full = e instanceof Error ? e.message : String(e);
  const first = full.split("\n")[0] ?? full;
  if (!NAVIGATION_CALL.test(first) || !isUnreachableTarget(first)) return null;
  const navigated = /navigating to "([^"]+)"/.exec(full)?.[1];
  let path: string | undefined;
  try {
    path = navigated === undefined ? undefined : new URL(navigated).pathname;
  } catch {
    path = undefined;
  }
  return `the app stopped responding to navigation${path === undefined ? "" : ` to ${path}`} (${describeUnreachable(first)})`;
}

/** True for a failure that means the app stopped answering (#226): the run is `inconclusive`, never `crashed`. */
export function isTargetUnresponsive(failure: MissionFailure | undefined): boolean {
  return failure?.kind === "target-unresponsive";
}
