import type { Page, Request } from "playwright";
import { redactUrl } from "@jevitate/ai-core";
import { writeClassifier } from "@jevitate/recording";
import { http5xxSignalOf, requestHeadersOf, rpc5xxSignalOf, type Http5xxSignal } from "../http-5xx.js";
import { FirstPartyOrigins } from "../third-party.js";
import { clock, isExternalSchemeUrl } from "@jevitate/domain";

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
  | {
      kind: "console-error";
      detail: string;
      pageUrl?: string;
      correlatedStatus?: number;
      correlatedUrl?: string;
      /**
       * #297: the (redacted) URL of the FRAME that logged it — the page's own document, or an
       * embedded iframe's — when it could be told (the message's source is a frame's document, or a
       * script that frame loaded). Unset when unknown: the error is then the page's own.
       */
      frameUrl?: string;
      /**
       * #297: the frame's origin when that frame is THIRD-PARTY to the run (`FirstPartyOrigins`, #194:
       * off the `--allow` origins' sites, never sent credentials) — a vendor's iframe logging its own
       * CSP noise. Such an error is advisory, never the app's defect (`isAdvisoryConsoleError`).
       */
      thirdPartyFrame?: string;
    }
  | { kind: "page-error"; detail: string; pageUrl?: string }
  /** `method` (#250): the request's HTTP method, when known — evidence only, never in the fingerprint. */
  | { kind: "http-5xx"; detail: string; url: string; status: number; method?: string }
  | { kind: "failed-request"; detail: string; url: string }
  /**
   * Horizontal-overflow (#149): pure DOM geometry (`packages/explore/src/overflow.ts`'s
   * `detectOverflow`), never a console/network event — synthesized once per adjudicated step and
   * folded into that step's hard signals the same way. `route`/`descriptor` are already the
   * finding's own (redacted, route-templated) values; `signalKey` keys on them directly.
   */
  | { kind: "horizontal-overflow"; detail: string; overflowPx: number; route: string; url: string; descriptor: string }
  /** Vertical clipping (#302): text cut off by a fixed-height box or above the page top — `overflow.ts`'s `detectClipping`. */
  | { kind: "vertical-clipping"; detail: string; clippedPx: number; cause: "overflow-hidden" | "above-page-top"; route: string; url: string; descriptor: string };

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
 * for three entirely benign cases (#73, #405):
 *
 *  - a connect-web/gRPC-web (or plain `fetch`) client that reads the response body and then aborts
 *    its own request/stream — the request already SUCCEEDED server-side (a response was received);
 *  - a request abandoned because the page navigated away or unmounted the component that issued it
 *    (React Query/connect cancel on unmount, a full navigation tearing down the old document);
 *  - #405: no response yet and the frame is still attached — the page's OWN AbortController cancelled
 *    a superseded READ (a type-ahead/search fetch or a read RPC) or a navigation request superseded
 *    by another navigation. The app changed its mind, not a failing server. An aborted WRITE is NOT
 *    benign — it may already have reached the server — so it still gates.
 *
 * A genuine network failure — DNS, connection, SSL, a timeout — reports a DIFFERENT `errorText` and
 * is unaffected.
 */
const ERR_ABORTED = "net::ERR_ABORTED";
/** #403: Chromium's net error (`…BLOCKED_BY_CLIENT.Inspector` from a route abort) for a request jevitate's guards stopped. */
const ERR_BLOCKED_BY_CLIENT = "net::ERR_BLOCKED_BY_CLIENT";

/**
 * #405: the read/write classifier the aborted-request rule uses. The collector is not given the
 * run's read-RPC patterns, so this uses `writeClassifier` defaults: a cancelled GET, or a cancelled
 * POST that is RPC-read-shaped, is the page's own superseded read and never a defect.
 */
const isWriteRequest = writeClassifier();

/**
 * A console-error CORRELATED with a captured network response (#88, extending #29's 5xx scope) is
 * classified by that response's status: a 5xx is still a defect (unchanged — it also gates
 * independently via `http-5xx`); a 4xx is ADVISORY — the app logged an error for a response the
 * server returned BY DESIGN (an authorization refusal, a validation error), so it is reported but
 * never counted as a defect. An UNCORRELATED console error (no response near it) stays a defect,
 * as before. A console error raised inside a THIRD-PARTY frame (#297, `thirdPartyFrame`) is
 * advisory too: a vendor's iframe (its own CSP violations, its own logging) is not the app.
 */
export function isAdvisoryConsoleError(signal: DefectSignal): signal is Extract<DefectSignal, { kind: "console-error" }> {
  if (signal.kind !== "console-error") return false;
  // #297: raised inside a third-party frame (a vendor's iframe) — never the app's own defect.
  if (signal.thirdPartyFrame !== undefined) return true;
  return signal.correlatedStatus !== undefined && signal.correlatedStatus >= 400 && signal.correlatedStatus < 500;
}

/** Most script URLs remembered per page for attributing a console message to its frame (#297). */
const MAX_SCRIPT_FRAMES = 1_000;

/** How close (ms) a response must be to a console error to correlate as "near in time" (#88). */
export const CORRELATION_WINDOW_MS = 2_000;

/** How many recent responses are kept for correlation (bounded so a chatty page cannot grow it). */
const MAX_RECENT_RESPONSES = 50;

export class PageSignalCollector {
  private buffer: DefectSignal[] = [];
  /** When each signal's request STARTED (this collector's clock) — see `requestStartOf`. */
  private readonly startedAt = new WeakMap<DefectSignal, number>();

  /**
   * `allowlist` (#208): the run's authorized origins — a 5xx from a THIRD-PARTY origin (#194,
   * `FirstPartyOrigins`) is not the app's defect and never becomes an `http-5xx` signal. Omitted,
   * every origin counts (the pre-#208 behaviour).
   */
  constructor(page: Page, now: () => number = clock.now, allowlist?: readonly string[]) {
    const responseSeen = new WeakSet<Request>();
    const requestStarted = new WeakMap<Request, number>();
    const firstParty = allowlist === undefined ? undefined : new FirstPartyOrigins(allowlist);
    // #297: which frame loaded each script — a console message's source is a script URL or a
    // frame's document URL, and the FRAME (not the script's host: an app may serve its own bundle
    // from a CDN) decides whose error it is.
    const scriptFrames = new Map<string, string | null>();
    page.on("request", (r) => {
      requestStarted.set(r, now());
      if (r.resourceType() === "script") {
        const frameUrl = frameUrlOf(r);
        if (frameUrl !== undefined && scriptFrames.size < MAX_SCRIPT_FRAMES) {
          const known = scriptFrames.get(r.url());
          // The same script loaded by frames of different origins: ambiguous, so never attributed.
          scriptFrames.set(r.url(), known === undefined || known === frameUrl || (known !== null && originOf(known) === originOf(frameUrl)) ? frameUrl : null);
        }
      }
      if (firstParty === undefined) return;
      const headers = requestHeadersOf(r);
      if (headers !== undefined) firstParty.observe(r.url(), headers);
    });
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
      // #403: the browser's note on a request jevitate's guard aborted — the run's refusal, not the app's.
      if (text.includes(ERR_BLOCKED_BY_CLIENT)) return;
      const redactedText = redactUrl(text);
      // Correlated against the REDACTED text (both sides of the match go through the same
      // redaction, so a query-string secret never breaks an otherwise-matching URL).
      const correlated = correlate(redactedText);
      const frameUrl = consoleFrameUrl(page, msg, scriptFrames);
      const thirdPartyFrame =
        frameUrl === undefined || firstParty === undefined || frameUrl === page.mainFrame().url() ? null : firstParty.thirdParty(frameUrl);
      this.buffer.push({
        kind: "console-error",
        detail: redactedText,
        pageUrl: redactUrl(page.url()),
        ...(correlated === undefined ? {} : { correlatedStatus: correlated.status, correlatedUrl: correlated.url }),
        ...(frameUrl === undefined ? {} : { frameUrl: redactUrl(frameUrl) }),
        ...(thirdPartyFrame === null ? {} : { thirdPartyFrame }),
      });
    });
    page.on("pageerror", (err) => {
      this.buffer.push({ kind: "page-error", detail: redactUrl(err.message), pageUrl: redactUrl(page.url()) });
    });
    page.on("response", (response) => {
      responseSeen.add(response.request());
      noteResponse(response.status(), redactUrl(response.url()));
      // The shared HTTP 5xx rule (#208): the same signal every strategy records.
      const request = response.request();
      const headers = firstParty === undefined ? undefined : requestHeadersOf(request);
      const push = (signal: Http5xxSignal): void => {
        const started = requestStarted.get(request);
        if (started !== undefined) this.startedAt.set(signal, started);
        this.buffer.push(signal);
      };
      const signal = http5xxSignalOf(response, firstParty, headers, methodOf(request));
      if (signal !== null) {
        push(signal);
        return;
      }
      // #378: an HTTP 200 gRPC-web/Connect RPC that failed server-side is the same hard signal.
      void rpc5xxSignalOf(response, firstParty, headers, methodOf(request)).then((s) => {
        if (s !== null) push(s);
      });
    });
    page.on("requestfailed", (request) => {
      // #375: an `sms:`/`tel:`/`mailto:`/app-deep-link navigation is handed to the OS, never fetched;
      // headless Chromium (no handler) reports it as ERR_ABORTED. Not a request of the system under
      // test — decided on the ORIGINAL url's scheme (redaction would hide it).
      if (isExternalSchemeUrl(request.url())) return;
      const errorText = request.failure()?.errorText ?? "request failed";
      // #403: a write jevitate's own guard aborted (`route.abort("blockedbyclient")`) — the run's
      // refusal, recorded as blocked by the guard, never a failure of the app.
      if (errorText.startsWith(ERR_BLOCKED_BY_CLIENT)) return;
      if (errorText === ERR_ABORTED) {
        // A response was already received: the client aborted after reading it (connect-web/gRPC-web).
        if (responseSeen.has(request)) return;
        // No response yet, but the request's own frame is gone: a navigation or component unmount
        // cancelled it — the page did this to itself, not a network failure.
        if (request.frame().isDetached()) return;
        // #405: no response and the frame is still attached — the app's own AbortController cancelled
        // a superseded READ (type-ahead/search fetch or read RPC) or a navigation request. The page
        // changed its mind; only an aborted WRITE (outcome-unknown to the server) still gates.
        if (request.isNavigationRequest() || !isWriteRequest({ method: request.method(), path: requestPathOf(request.url()) })) return;
      }
      this.buffer.push({
        kind: "failed-request",
        detail: redactUrl(errorText),
        url: redactUrl(request.url()),
      });
    });
  }

  /**
   * When the request behind a drained `http-5xx` signal STARTED (this collector's clock), or
   * undefined when unknown (#250). A mission attributes the signal to the action that fired the
   * request by it — not to whichever step happened to drain the buffer (a submit left pending while
   * the next step ran would otherwise blame that next step).
   */
  requestStartOf(signal: DefectSignal): number | undefined {
    return this.startedAt.get(signal);
  }

  /** Everything buffered since the last drain; clears the buffer. */
  drain(): DefectSignal[] {
    const out = this.buffer;
    this.buffer = [];
    return out;
  }
}

/** A request URL's pathname (#405), or the raw URL when it cannot be parsed. */
function requestPathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

/** A request's method without throwing (a stub request may not expose it). */
function methodOf(r: { method?: () => string } | undefined): string | undefined {
  try {
    return typeof r?.method === "function" ? r.method() : undefined;
  } catch {
    return undefined;
  }
}

/** The URL of the frame a request belongs to, without throwing (a stub, or a frame already gone). */
function frameUrlOf(r: Request): string | undefined {
  try {
    const u = r.frame().url();
    return u === "" ? undefined : u;
  } catch {
    return undefined;
  }
}

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/**
 * The URL of the frame a console message came from (#297), or undefined when it cannot be told.
 * A message's `location().url` is the document of the frame that logged it (an inline script, a
 * browser-generated CSP violation) or the script that called `console.error`; the latter is mapped
 * to the frame that loaded it. Unknown → undefined: the error stays the page's own (fail closed).
 */
function consoleFrameUrl(
  page: Page,
  msg: { location(): { url: string } },
  scriptFrames: ReadonlyMap<string, string | null>,
): string | undefined {
  let source: string;
  try {
    source = msg.location().url;
  } catch {
    return undefined;
  }
  if (source === "") return undefined;
  const frames = page.frames();
  if (frames.some((f) => f.url() === source)) return source;
  return scriptFrames.get(source) ?? undefined;
}
