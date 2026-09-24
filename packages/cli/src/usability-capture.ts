// usability-capture.ts — what a live usability run measures besides the rubric evidence (#96/#98):
//
//   - a per-step SCREENSHOT of every screen the run decides on, with every secret-bearing element
//     MASKED by Playwright before the pixels are captured (password/OTP inputs, bound secret
//     fields, and any element whose text or value holds a registered secret) — fail-closed: when
//     the secret scan cannot run, no screenshot is written at all;
//   - the REQUESTS the page made (fetch/xhr/document: method, endpoint, status, start/end), each
//     attributed to the step whose action it followed;
//   - per-screen facts the signal oracles need (url, signature, visible text, a busy indicator).
//
// Everything stored here is redacted (redactUrl + the run's secrets) before it is kept; nothing
// here ever reaches a model. The capture is advisory: a failure to screenshot or to read the page
// never affects the run.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Locator, Page, Request } from "playwright";
import { endpointOf, redactText, redactUrl, type SecretField, type Snapshot, type TranscriptEntry } from "@jevitate/explore";
import type { RunSignalCapture, SignalRequest, SignalScreen, SignalStep } from "@jevitate/ux";

/** Secret-bearing inputs — the same predicate as `@jevitate/recorder`'s `isSecretField`, in CSS. */
export const SECRET_INPUT_SELECTOR = [
  'input[type="password" i]',
  '[autocomplete~="current-password" i]',
  '[autocomplete~="new-password" i]',
  '[autocomplete~="one-time-code" i]',
  '[autocomplete~="otp" i]',
].join(", ");

/** The attribute the in-page secret scan marks an element with (removed after the screenshot). */
const MASK_ATTR = "data-jevitate-mask";
/** The opaque box drawn over every masked element (Playwright's own default, pinned). */
export const MASK_COLOR = "#FF00FF";
const KEPT_TYPES =new Set(["fetch", "xhr", "document"]);
const SCREENSHOT_TIMEOUT_MS = 5_000;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/** A bound secret field's matcher → a locator for every element it could match. */
function boundFieldLocator(page: Page, f: SecretField): Locator {
  const v = JSON.stringify(f.matcher.value);
  switch (f.matcher.key) {
    case "label":
      return page.getByLabel(f.matcher.value, { exact: true });
    case "testId":
      return page.getByTestId(f.matcher.value);
    case "type":
      return page.locator(`input[type=${v} i]`);
    case "id":
      return page.locator(`[id=${v}]`);
    case "name":
      return page.locator(`[name=${v}]`);
  }
}

/**
 * BROWSER CODE — marks every element whose text or form value holds a registered secret, and
 * reports whether a busy/progress/status indicator is on screen. The secrets are handed to the
 * browser that already holds them (it rendered or was typed them); they never leave it.
 */
function scanPage(args: { secrets: readonly string[]; attr: string }): { marked: number; busy: boolean } {
  let marked = 0;
  if (args.secrets.length > 0) {
    const holds = (s: string | null | undefined): boolean => !!s && args.secrets.some((x) => s.includes(x));
    for (const el of Array.from(document.querySelectorAll("input, textarea, select"))) {
      if (holds((el as HTMLInputElement).value)) {
        el.setAttribute(args.attr, "");
        marked++;
      }
    }
    const walker = document.createTreeWalker(document.body ?? document.documentElement, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n !== null; n = walker.nextNode()) {
      if (holds(n.nodeValue) && n.parentElement !== null) {
        n.parentElement.setAttribute(args.attr, "");
        marked++;
      }
    }
  }
  const busy =
    document.querySelector('[aria-busy="true"], [role="progressbar"], progress, .spinner, [class*="spinner" i], [class*="loading" i]') !== null ||
    Array.from(document.querySelectorAll('[role="status"], [aria-live]')).some((el) => (el.textContent ?? "").trim().length > 0);
  return { marked, busy };
}

function unmark(attr: string): void {
  for (const el of Array.from(document.querySelectorAll(`[${attr}]`))) el.removeAttribute(attr);
}

export interface UsabilityCaptureOptions {
  readonly page: Page;
  /** Directory the per-step screenshots are written to (created on the first screenshot). */
  readonly screenshotDir: string;
  /** Every run secret (registered + bound values): masked on screen, redacted in every string kept. */
  readonly secrets: readonly string[];
  readonly secretFields?: readonly SecretField[];
  readonly now?: () => number;
}

interface LiveRequest {
  id: number;
  method: string;
  endpoint: string;
  url: string;
  resourceType: string;
  startedAt: number;
  endedAt: number | null;
  status: number | null;
  failed?: boolean;
  step: number;
  contentType?: string;
}

/** A request's own `content-type` header (#110: tells a gRPC-web/Connect read from a write). */
function requestContentType(r: Request): string | undefined {
  try {
    const v = r.headers()["content-type"];
    return typeof v === "string" && v !== "" ? v : undefined;
  } catch {
    return undefined;
  }
}

export class UsabilityCapture {
  readonly #opts: UsabilityCaptureOptions;
  readonly #now: () => number;
  readonly #requests: LiveRequest[] = [];
  readonly #live = new Map<Request, LiveRequest>();
  readonly #screens: SignalScreen[] = [];
  /** Step number → the screenshot of the screen that step was decided on. */
  readonly #shotByStep = new Map<number, string>();
  /** Status reads still in flight (awaited before the capture is handed out). */
  readonly #statusReads: Promise<void>[] = [];
  #entries = 0;
  #step = 0;
  #detached = false;

  constructor(opts: UsabilityCaptureOptions) {
    this.#opts = opts;
    this.#now = opts.now ?? Date.now;
    opts.page.on("request", this.#onRequest);
    opts.page.on("requestfinished", this.#onFinished);
    opts.page.on("requestfailed", this.#onFailed);
  }

  #redact(s: string): string {
    return redactText(s, this.#opts.secrets);
  }

  readonly #onRequest = (r: Request): void => {
    if (!KEPT_TYPES.has(r.resourceType())) return;
    const rec: LiveRequest = {
      id: this.#requests.length,
      method: r.method(),
      endpoint: this.#redact(endpointOf(r.method(), r.url())),
      url: this.#redact(redactUrl(r.url())),
      resourceType: r.resourceType(),
      startedAt: this.#now(),
      endedAt: null,
      status: null,
      step: this.#step,
    };
    const contentType = requestContentType(r);
    if (contentType !== undefined) rec.contentType = contentType;
    this.#requests.push(rec);
    this.#live.set(r, rec);
  };

  readonly #onFinished = (r: Request): void => {
    const rec = this.#live.get(r);
    if (rec === undefined) return;
    this.#live.delete(r);
    rec.endedAt = this.#now();
    this.#statusReads.push(
      r.response().then(
        (res) => {
          rec.status = res?.status() ?? null;
        },
        () => undefined,
      ),
    );
  };

  readonly #onFailed = (r: Request): void => {
    const rec = this.#live.get(r);
    if (rec === undefined) return;
    this.#live.delete(r);
    rec.endedAt = this.#now();
    rec.failed = true;
  };

  /** TranscriptLog listener: counts the steps recorded so far (a snapshot belongs to the next one). */
  noteEntry(_entry: TranscriptEntry, all: readonly TranscriptEntry[]): void {
    this.#entries = all.length;
  }

  /** The transcript with each step's screenshot path added (what the journal persists). */
  withScreenshots(entries: readonly TranscriptEntry[]): Array<TranscriptEntry & { screenshot?: string }> {
    return entries.map((e) => {
      const shot = this.#shotByStep.get(e.step);
      return shot === undefined ? e : { ...e, screenshot: shot };
    });
  }

  /**
   * One observed screen: its (masked) screenshot and its facts. Returns the screenshot path, or
   * `null` when none was written (fail-closed secret scan, or the page did not answer in time).
   */
  async observe(snap: Snapshot, visibleText: string): Promise<string | null> {
    const step = this.#entries + 1;
    this.#step = step;
    const index = this.#screens.length;
    const { page, secrets } = this.#opts;
    let busy = false;
    let shot: string | null = null;
    let scanned = false;
    try {
      ({ busy } = await withTimeout(page.evaluate(scanPage, { secrets: [...secrets], attr: MASK_ATTR }), SCREENSHOT_TIMEOUT_MS));
      scanned = true;
    } catch {
      scanned = false; // cannot prove where a secret is ⇒ no screenshot (fail-closed)
    }
    if (scanned) {
      const path = join(this.#opts.screenshotDir, `screen-${index + 1}-step-${step}.png`);
      const mask: Locator[] = [
        page.locator(SECRET_INPUT_SELECTOR),
        page.locator(`[${MASK_ATTR}]`),
        ...(this.#opts.secretFields ?? []).map((f) => boundFieldLocator(page, f)),
      ];
      try {
        mkdirSync(this.#opts.screenshotDir, { recursive: true });
        await page.screenshot({ path, mask, maskColor: MASK_COLOR, fullPage: true, timeout: SCREENSHOT_TIMEOUT_MS });
        shot = path;
      } catch {
        shot = null;
      }
      await withTimeout(page.evaluate(unmark, MASK_ATTR), SCREENSHOT_TIMEOUT_MS).catch(() => undefined);
    }
    if (shot !== null) this.#shotByStep.set(step, shot);
    this.#screens.push({
      index,
      step,
      at: this.#now(),
      url: this.#redact(redactUrl(snap.url)),
      signature: snap.signature,
      visibleText: this.#redact(visibleText),
      busy,
      ...(shot === null ? {} : { screenshot: shot }),
    });
    return shot;
  }

  /** Every screenshot written, in order. */
  screenshots(): string[] {
    return this.#screens.flatMap((s) => (s.screenshot === undefined ? [] : [s.screenshot]));
  }

  /** Stops listening; the capture is frozen from here. */
  detach(): void {
    if (this.#detached) return;
    this.#detached = true;
    this.#opts.page.off("request", this.#onRequest);
    this.#opts.page.off("requestfinished", this.#onFinished);
    this.#opts.page.off("requestfailed", this.#onFailed);
  }

  /** The run's signal capture (steps from the final transcript). */
  async signalCapture(transcript: readonly TranscriptEntry[], typedValues: readonly string[]): Promise<RunSignalCapture> {
    this.detach();
    await Promise.allSettled(this.#statusReads);
    const steps: SignalStep[] = transcript.map((e) => ({
      step: e.step,
      op: e.op,
      target: e.target,
      actOk: e.actOk,
      url: e.url,
      ...(e.descriptor === undefined ? {} : { descriptor: e.descriptor }),
      ...(e.reason === undefined ? {} : { reason: e.reason }),
    }));
    const requests: SignalRequest[] = this.#requests.map((r) => ({ ...r }));
    return { steps, requests, screens: [...this.#screens], endedAt: this.#now(), typedValues };
  }
}
