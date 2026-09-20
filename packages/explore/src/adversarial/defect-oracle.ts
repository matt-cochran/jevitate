import type { Page } from "playwright";

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
 */

export type DefectSignal =
  | { kind: "console-error"; detail: string }
  | { kind: "page-error"; detail: string }
  | { kind: "http-5xx"; detail: string; url: string; status: number }
  | { kind: "failed-request"; detail: string; url: string };

export class PageSignalCollector {
  private buffer: DefectSignal[] = [];

  constructor(page: Page) {
    page.on("console", (msg) => {
      if (msg.type() === "error") this.buffer.push({ kind: "console-error", detail: msg.text() });
    });
    page.on("pageerror", (err) => {
      this.buffer.push({ kind: "page-error", detail: err.message });
    });
    page.on("response", (response) => {
      const status = response.status();
      if (status >= 500) {
        this.buffer.push({
          kind: "http-5xx",
          detail: `${status} ${response.url()}`,
          url: response.url(),
          status,
        });
      }
    });
    page.on("requestfailed", (request) => {
      this.buffer.push({
        kind: "failed-request",
        detail: request.failure()?.errorText ?? "request failed",
        url: request.url(),
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
