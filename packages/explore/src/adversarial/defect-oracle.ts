import type { Page, Request } from "playwright";
import { redactUrl } from "@jevitate/ai-core";

/**
 * The adversarial mission's TRUSTED HARD-SIGNAL defect oracle (spec §3.1/§9).
 *
 * A defect is concluded ONLY from an independent, mechanical signal — a JS
 * console error, an HTTP 5xx response, a failed network request, or an
 * unhandled page exception — or from a user-declared invariant checked by the
 * mission loop. Jev's "does this look broken?" `Noul` is NEVER a signal here;
 * it is a soft augment attached to triage context only (guardrail #4). This
 * class is the sole thing the mission trusts to say "something broke."
 *
 * Listeners are attached at CONSTRUCTION time — before the mission navigates
 * anywhere — so no signal window is missed. `drain()` returns everything
 * buffered since the last drain and clears the buffer, so a signal is never
 * double-counted across two checks.
 *
 * Every URL (and any URL quoted in a detail message) is passed through the
 * shared `redactUrl` rule at capture time: these signals feed the triage model
 * call and the reported defect.
 */

export type DefectSignal =
  /**
   * `pageUrl`: the (redacted) page the signal fired on — the route part of its fingerprint.
   * `correlatedStatus`/`correlatedUrl` (#88): the captured network response this console error
   * correlates with (the same request, or the nearest response within `CORRELATION_WINDOW_MS`) —
   * undefined when none was found. See `isAdvisoryConsoleError`.
   */
  | { kind: "console-error"; detail: string; pageUrl?: string; correlatedStatus?: number; correlatedUrl?: string }
  | { kind: "page-error"; detail: string; pageUrl?: string }
  | { kind: "http-5xx"; detail: string; url: string; status: number }
  | { kind: "failed-request"; detail: string; url: string };

/**
 * Chromium emits a browser-generated console "error" for EVERY failed resource
 * load, of the fixed form
 * `Failed to load resource: the server responded with a status of <NNN> ...`.
 * Under adversarial MISUSE a legitimate 4xx (a 400/403/404 the app returns by
 * design when we feed it bad input or hit a gated/absent route) is EXPECTED —
 * it is not a defect. The spec scopes the HTTP hard-signal to 5xx (§9), so a
 * sub-5xx resource-load console error is pairing noise, not a signal.
 *
 * This scopes ONLY that specific browser message by its embedded status. It
 * never masks a real defect: an app `console.error()` call carries no such
 * pattern and still gates; a page exception gates via `pageerror`; a genuine
 * 5xx gates via the `response` listener (and a 5xx resource message is NOT
 * suppressed here, so it also still surfaces as a console-error); a network-
 * level failure gates via `requestfailed`.
 */
const RESOURCE_LOAD_STATUS = /Failed to load resource: the server responded with a status of (\d{3})\b/i;

export function isNon5xxResourceConsoleError(text: string): boolean {
  const match = RESOURCE_LOAD_STATUS.exec(text);
  if (match === null) return false;
  return Number(match[1]) < 500;
}

/**
 * Chromium's net error for a request the CLIENT cancelled — never a network-level failure. It fires
 * for two entirely benign cases (#73):
 *
 *  - a connect-web/gRPC-web (or plain `fetch`) client that reads the response body and then aborts
 *    its own request/stream — the request already SUCCEEDED server-side (a response was received);
 *  - a request abandoned because the page navigated away or unmounted the component that issued it
 *    (React Query/connect cancel on unmount, a full navigation tearing down the old document).
 *
 * Neither is evidence the system under test is broken. A genuine network failure — DNS, connection,
 * SSL, a timeout — reports a DIFFERENT `errorText` and is unaffected.
 */
const ERR_ABORTED = "net::ERR_ABORTED";

/**
 * A console-error CORRELATED with a captured network response (#88, extending #29's 5xx scope) is
 * classified by that response's status: a 5xx is still a defect (unchanged — it also gates
 * independently via `http-5xx`); a 4xx is ADVISORY — the app logged an error for a response the
 * server returned BY DESIGN (an authorization refusal, a validation error), so it is reported but
 * never counted as a defect. An UNCORRELATED console error (no response near it) stays a defect,
 * as before.
 */
export function isAdvisoryConsoleError(
  signal: DefectSignal,
): signal is Extract<DefectSignal, { kind: "console-error" }> & { correlatedStatus: number } {
  return (
    signal.kind === "console-error" &&
    signal.correlatedStatus !== undefined &&
    signal.correlatedStatus >= 400 &&
    signal.correlatedStatus < 500
  );
}

/** How close (ms) a response must be to a console error to correlate as "near in time" (#88). */
export const CORRELATION_WINDOW_MS = 2_000;

/** How many recent responses are kept for correlation (bounded so a chatty page cannot grow it). */
const MAX_RECENT_RESPONSES = 50;

export class PageSignalCollector {
  private buffer: DefectSignal[] = [];

  constructor(page: Page, now: () => number = Date.now) {
    const responseSeen = new WeakSet<Request>();
    // Every response seen recently, for correlating a console error to WHAT it was about (#88): the
    // same request (its URL quoted in the message) or, failing that, the nearest one in time.
    const recent: Array<{ status: number; url: string; at: number }> = [];
    const noteResponse = (status: number, url: string): void => {
      recent.push({ status, url, at: now() });
      if (recent.length > MAX_RECENT_RESPONSES) recent.shift();
    };
    const correlate = (text: string): { status: number; url: string } | undefined => {
      // Same request: the message quotes the exact (redacted) response URL.
      const sameRequest = recent.find((r) => text.includes(r.url));
      if (sameRequest !== undefined) return sameRequest;
      // Near in time: the closest response within the correlation window, before or shortly after
      // (a same-tick console.error can log a hair before its response event is processed).
      const t = now();
      let best: { status: number; url: string; at: number } | undefined;
      for (const r of recent) {
        if (Math.abs(t - r.at) > CORRELATION_WINDOW_MS) continue;
        if (best === undefined || Math.abs(t - r.at) < Math.abs(t - best.at)) best = r;
      }
      return best;
    };
    page.on("console", (msg) => {
      if (msg.type() !== "error") return;
      const text = msg.text();
      // Scope the console hard-signal to exclude 4xx resource-load noise (spec
      // §9: the HTTP signal is 5xx-only). Real console errors, page errors and
      // 5xx are untouched and still gate.
      if (isNon5xxResourceConsoleError(text)) return;
      const redactedText = redactUrl(text);
      // Correlated against the REDACTED text (both sides of the match go through the same
      // redaction, so a query-string secret never breaks an otherwise-matching URL).
      const correlated = correlate(redactedText);
      this.buffer.push({
        kind: "console-error",
        detail: redactedText,
        pageUrl: redactUrl(page.url()),
        ...(correlated === undefined ? {} : { correlatedStatus: correlated.status, correlatedUrl: correlated.url }),
      });
    });
    page.on("pageerror", (err) => {
      this.buffer.push({ kind: "page-error", detail: redactUrl(err.message), pageUrl: redactUrl(page.url()) });
    });
    page.on("response", (response) => {
      responseSeen.add(response.request());
      const status = response.status();
      noteResponse(status, redactUrl(response.url()));
      if (status >= 500) {
        const url = redactUrl(response.url());
        this.buffer.push({ kind: "http-5xx", detail: `${status} ${url}`, url, status });
      }
    });
    page.on("requestfailed", (request) => {
      const errorText = request.failure()?.errorText ?? "request failed";
      if (errorText === ERR_ABORTED) {
        // A response was already received: the client aborted after reading it (connect-web/gRPC-web).
        if (responseSeen.has(request)) return;
        // No response yet, but the request's own frame is gone: a navigation or component unmount
        // cancelled it — the page did this to itself, not a network failure.
        if (request.frame().isDetached()) return;
      }
      this.buffer.push({
        kind: "failed-request",
        detail: redactUrl(errorText),
        url: redactUrl(request.url()),
      });
    });
  }

  /** Everything buffered since the last drain; clears the buffer. */
  drain(): DefectSignal[] {
    const out = this.buffer;
    this.buffer = [];
    return out;
  }
}
