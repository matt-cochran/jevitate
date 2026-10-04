import { createHash, randomBytes } from "node:crypto";
import type { Page } from "playwright";
import { CANARY_ATTRIBUTE } from "./input-strategy.js";
import { clock } from "@jevitate/domain";

/**
 * #301 — the inert markup canary: does the app render a field's input as MARKUP (unescaped HTML or
 * an unescaped attribute value) after it is submitted, and does that survive a reload (stored) or not
 * (reflected)?
 *
 * The payloads (`markupCanary` / `attributeCanary` in `input-strategy.ts`) are inert: an `<i>`
 * element or a bare data attribute carrying a per-submission token — never a script, an event
 * handler or a `javascript:` URL, nothing that executes. Detection is DOM inspection only: an element
 * carrying `data-jev-canary="<token>"` exists only when the input was parsed as markup; a canary
 * rendered as escaped text never creates one, and the typed field's own `value` is not an attribute.
 * Limits: it proves unescaped rendering, it never attempts exploitation; markup inside a closed
 * shadow root, a cross-origin frame, or rendered only on a page the run never visits is not seen.
 */

/** A run's canary token source: a random prefix (8 hex) plus a counter — `[a-z0-9]` only. */
export class CanaryTokens {
  readonly prefix: string;
  #n = 0;

  constructor(prefix: string = randomBytes(4).toString("hex")) {
    this.prefix = prefix;
  }

  next(): string {
    const t = `${this.prefix}${this.#n.toString(36)}`;
    this.#n += 1;
    return t;
  }
}

/** Bound on reading one frame (ms). */
const READ_TIMEOUT_MS = 2_000;

const TOKEN_IN_VALUE = new RegExp(`${CANARY_ATTRIBUTE}="([a-z0-9]+)`);

/** The canary token a typed value carries, or null. */
export function canaryTokenOf(value: string | undefined): string | null {
  if (value === undefined) return null;
  return TOKEN_IN_VALUE.exec(value)?.[1] ?? null;
}

/** Which payload a canary value is: an HTML element, or an attribute break. */
export function canaryPayloadOf(value: string): "html" | "attribute" {
  return value.trimStart().startsWith("<") ? "html" : "attribute";
}

/**
 * The run's canary tokens rendered as markup on `page` right now: every element carrying the canary
 * attribute with this run's prefix, in the main frame and in frames on an authorized origin.
 * Read-only; never throws (a frame that cannot be read is skipped).
 */
export async function renderedCanaries(page: Page, prefix: string, authorized: (url: string) => boolean): Promise<Set<string>> {
  const out = new Set<string>();
  const main = page.mainFrame();
  for (const frame of page.frames()) {
    if (frame !== main && !authorized(frame.url())) continue;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // Bounded: a frame whose document never arrives (an app that stopped answering) is skipped.
      const timeout = new Promise<string[]>((resolve) => {
        timer = clock.setTimeout(() => resolve([]), READ_TIMEOUT_MS);
      });
      const read = frame.evaluate(
        ({ attr, pre }) =>
          Array.from(document.querySelectorAll(`[${attr}]`))
            .map((e) => e.getAttribute(attr) ?? "")
            .filter((v) => v.startsWith(pre)),
        { attr: CANARY_ATTRIBUTE, pre: prefix },
      );
      const found = await Promise.race([read, timeout]);
      read.catch(() => undefined);
      for (const t of found) out.add(t);
    } catch {
      // a detached or navigating frame: nothing read
    } finally {
      clock.clearTimeout(timer);
    }
  }
  return out;
}

/** #319: how long a check waits for a just-submitted canary to render, and how often it looks. */
export const CANARY_RENDER_WAIT_MS = 1_500;
const CANARY_POLL_MS = 50;

/**
 * #319 — {@link renderedCanaries}, given the page a bounded moment to render what it renders
 * asynchronously (a list fetched after a submit or a reload): it reads again until one of the
 * `expected` (just-submitted) tokens is rendered, or `waitMs` has passed. With no expected token it
 * reads once. A canary that never renders is simply absent: waiting changes no verdict, only when
 * it is read.
 */
export async function renderedCanariesSettled(
  page: Page,
  prefix: string,
  authorized: (url: string) => boolean,
  expected: readonly string[],
  waitMs = CANARY_RENDER_WAIT_MS,
): Promise<Set<string>> {
  const deadline = clock.monotonicMs() + waitMs;
  let seen = await renderedCanaries(page, prefix, authorized);
  while (expected.length > 0 && !expected.some((t) => seen.has(t)) && clock.monotonicMs() < deadline) {
    await clock.sleep(CANARY_POLL_MS);
    seen = await renderedCanaries(page, prefix, authorized);
  }
  return seen;
}

/** A `markup-injection` defect's stable identity: field + submitting route + payload kind (16 hex). */
export function markupFingerprint(route: string, field: string, payload: "html" | "attribute"): string {
  return createHash("sha256").update(`markup-injection|${route}|${field}|${payload}`).digest("hex").slice(0, 16);
}
