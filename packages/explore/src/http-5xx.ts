import type { Page, Request, Response } from "playwright";
import { redactUrl } from "@jevitate/ai-core";
import type { DefectSignal } from "./adversarial/defect-oracle.js";
import { defectTitle, normalizeRoute, signalFingerprint } from "./adversarial/defect-fingerprint.js";
import { FirstPartyOrigins } from "./third-party.js";

/**
 * The HTTP 5xx HARD SIGNAL, shared by every strategy (#208). One place decides "this response is an
 * app defect": a response with status >= 500 from a FIRST-PARTY origin (#194 — the run's `--allow`
 * origins and their sites, or an origin the page sent API credentials to). A 5xx from a third-party
 * origin (an analytics beacon, a payment provider's fraud endpoint) is not the app's defect.
 *
 * The adversarial mission's `PageSignalCollector` turns a response into its signal through
 * `http5xxSignalOf`; every other strategy (goal, feature, coverage/exploratory, usability) records
 * through `Http5xxOracle`, attached to the run's page before the first navigation. Both emit the SAME
 * `http-5xx` signal and fingerprint (`signalFingerprint`: kind + endpoint pattern + exact status), so
 * one bug has one identity whichever strategy found it — and `verify-fix` re-checks it the same way.
 *
 * Every URL goes through the shared `redactUrl` rule at capture time.
 */

export type Http5xxSignal = Extract<DefectSignal, { kind: "http-5xx" }>;

/**
 * A response's `http-5xx` signal, or null when it is not an app defect: a status below 500, or a
 * response from a third-party origin (`firstParty` given — without it every origin counts).
 */
export function http5xxSignalOf(
  response: { status(): number; url(): string },
  firstParty?: FirstPartyOrigins,
  headers?: Readonly<Record<string, string>>,
): Http5xxSignal | null {
  const status = response.status();
  if (status < 500) return null;
  if (firstParty !== undefined && firstParty.thirdParty(response.url(), headers) !== null) return null;
  const url = redactUrl(response.url());
  return { kind: "http-5xx", detail: `${status} ${url}`, url, status };
}

/** Request headers without throwing (a stub request may not expose them). */
export function requestHeadersOf(r: { headers(): Record<string, string> }): Record<string, string> | undefined {
  try {
    return r.headers();
  } catch {
    return undefined;
  }
}

/** A run's HTTP 5xx defect (#208) — the adversarial defect shape, minus its triage and misuse repro. */
export interface Http5xxDefect {
  /** `signalFingerprint` of its signal — the same identity the adversarial mission gives it. */
  readonly fingerprint: string;
  readonly related: string[];
  readonly kind: "http-5xx";
  readonly title: string;
  /** Normalized route (path pattern) of the page it fired on. */
  readonly route: string;
  /** The (redacted) page URL it fired on. */
  readonly url: string;
  /** The request's method (`PUT`, `GET`, …). */
  readonly method: string;
  /** The first occurrence's signal. */
  readonly signals: Http5xxSignal[];
  /** The transcript step whose window the request started in (see `Http5xxOracle`). */
  readonly firstSeenStep: number;
  readonly occurrences: number;
  readonly occurrenceSteps: number[];
  /** Where `verify-fix` replays the run's Recording to (the attributed step's last Recording step). */
  readonly repro: { readonly recordingStepIndex: number };
}

interface Observed {
  readonly signal: Http5xxSignal;
  readonly method: string;
  readonly pageUrl: string;
  /** When the request STARTED (the oracle's clock): the action that fired it owns it. */
  readonly startedAt: number;
}

/**
 * Records every first-party HTTP 5xx a run's page receives and turns them into defects at the end.
 *
 * Attribution is by time, from the run's own transcript: `noteStep` is called as each transcript
 * entry is emitted (after its action settled), so a request that STARTED after step N-1's entry and
 * at or before step N's belongs to step N — the seed load belongs to the first step, and anything
 * after the last entry (async work landing late) to the last one. A background request (a poll, a
 * heartbeat) is attributed the same way: a server error is a defect whoever fired it.
 *
 * Requests the read-only guard blocks (#158) are aborted before they leave the browser, so they
 * never produce a response — and never a signal here.
 */
export class Http5xxOracle {
  readonly #now: () => number;
  readonly #firstParty: FirstPartyOrigins;
  readonly #started = new WeakMap<Request, number>();
  readonly #observed: Observed[] = [];
  readonly #steps: Array<{ readonly step: number; readonly at: number }> = [];

  constructor(page: Page, opts: { readonly allowlist: readonly string[]; readonly now?: () => number }) {
    this.#now = opts.now ?? Date.now;
    this.#firstParty = new FirstPartyOrigins(opts.allowlist);
    page.on("request", (r: Request) => {
      this.#started.set(r, this.#now());
      const headers = requestHeadersOf(r);
      if (headers !== undefined) this.#firstParty.observe(r.url(), headers);
    });
    page.on("response", (response: Response) => {
      const request = response.request();
      const signal = http5xxSignalOf(response, this.#firstParty, requestHeadersOf(request));
      if (signal === null) return;
      // A document's own 5xx (the start page itself) fires before `page.url()` moves to it.
      const isDocument = request.isNavigationRequest() && request.frame() === page.mainFrame();
      this.#observed.push({
        signal,
        method: request.method().toUpperCase(),
        pageUrl: isDocument ? signal.url : redactUrl(page.url()),
        startedAt: this.#started.get(request) ?? this.#now(),
      });
    });
  }

  /** A transcript entry was emitted (its action settled): closes that step's attribution window. */
  noteStep(entry: { readonly step: number }): void {
    this.#steps.push({ step: entry.step, at: this.#now() });
  }

  /** How many 5xx signals were recorded so far (before dedup). */
  get count(): number {
    return this.#observed.length;
  }

  /** The run's HTTP 5xx defects, one per fingerprint, in first-seen order. */
  defects(transcript: readonly { readonly step: number; readonly actOk: boolean }[]): Http5xxDefect[] {
    const byFp = new Map<string, { defect: Http5xxDefect; steps: number[]; count: number }>();
    for (const o of this.#observed) {
      const step = this.#stepOf(o.startedAt);
      const fingerprint = signalFingerprint(o.signal);
      const known = byFp.get(fingerprint);
      if (known !== undefined) {
        known.count += 1;
        if (!known.steps.includes(step)) known.steps.push(step);
        continue;
      }
      byFp.set(fingerprint, {
        count: 1,
        steps: [step],
        defect: {
          fingerprint,
          related: [fingerprint],
          kind: "http-5xx",
          title: defectTitle(o.signal),
          route: normalizeRoute(o.pageUrl),
          url: o.pageUrl,
          method: o.method,
          signals: [o.signal],
          firstSeenStep: step,
          occurrences: 1,
          occurrenceSteps: [],
          repro: { recordingStepIndex: recordingStepIndexFor(transcript, step) },
        },
      });
    }
    return [...byFp.values()].map(({ defect, steps, count }) => ({ ...defect, occurrences: count, occurrenceSteps: steps }));
  }

  #stepOf(startedAt: number): number {
    for (const s of this.#steps) if (startedAt <= s.at) return s.step;
    return this.#steps[this.#steps.length - 1]?.step ?? 0;
  }
}

/**
 * The flat Recording step index for a transcript step: a failed action (`actOk: false`) never
 * becomes a Recording step, so only the successful ones up to and including `uptoStep` count.
 * Clamped to 0 (replay from the start — always a safe anchor).
 */
function recordingStepIndexFor(transcript: readonly { readonly step: number; readonly actOk: boolean }[], uptoStep: number): number {
  let idx = -1;
  for (const e of transcript) {
    if (e.step > uptoStep) break;
    if (e.actOk) idx += 1;
  }
  return Math.max(0, idx);
}
