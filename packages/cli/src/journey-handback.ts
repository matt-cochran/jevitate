import type { Page, Request, Route } from "playwright";
import { FirstPartyOrigins, ReadOnlyGuard } from "@jevitate/explore";
import { writeClassifier } from "@jevitate/recording";
import {
  classifyHandback,
  flatJourneySteps,
  type HandbackFacts,
  type HandbackOutcome,
  type Journey,
} from "@jevitate/journey";
import type { JourneyRunResult } from "@jevitate/runtime";

/**
 * #583 — the CLI wiring of a prepare-only boundary: refuse self-heal before any browser opens, watch
 * (or with `blockWrites` abort) every first-party write for the whole run, and classify the run's
 * facts into the typed `handback` result. The classifier itself is pure (`@jevitate/journey`).
 */

/** A self-heal was requested for a Journey whose prepare-only boundary forbids it (§3). */
export class BoundaryNoHealError extends Error {
  readonly code = "E_BOUNDARY_NO_HEAL";
  constructor(message: string) {
    super(message);
    this.name = "BoundaryNoHealError";
  }
}

/**
 * §3: a Journey with a prepare-only boundary never self-heals — a changed account, target, text or
 * context fails closed. Refused before any browser opens; a retarget can only be proposed through
 * the existing reviewed heal-revision flow, never applied during the run.
 */
export function assertHandbackNoHeal(journey: Journey, selfHealRequested: boolean): void {
  if (journey.metadata.boundary === undefined || !selfHealRequested) return;
  throw new BoundaryNoHealError(
    `journey '${journey.metadata.id}' declares a prepare-only boundary — self-heal is refused (E_BOUNDARY_NO_HEAL); a retarget can only be proposed through the reviewed heal-revision flow`,
  );
}

/** The whole-run write counts the classifier's facts read. */
export interface HandbackWriteCounts {
  readonly writes: number;
  readonly writesBlocked: number;
  readonly observation: "available" | "unavailable";
}

/**
 * §3: a whole-run first-party write observer. Every first-party write the page sends is counted (the
 * same #110 classifier `journey lint` uses); with `blockWrites` each is aborted by a `ReadOnlyGuard`
 * whose action window stays open for the whole run, and still counted. Observe-only by default.
 */
export class HandbackWriteObserver {
  readonly #classifier = writeClassifier({});
  readonly #allowedOrigins: readonly string[];
  readonly #firstParty: FirstPartyOrigins;
  readonly #block: boolean;
  #page: Page | undefined;
  #guard: ReadOnlyGuard | undefined;
  #writes = 0;
  #observation: "available" | "unavailable" = "available";
  readonly #handler = (route: Route, request: Request): Promise<void> => this.#route(route, request);

  constructor(allowedOrigins: readonly string[], opts: { readonly blockWrites?: boolean } = {}) {
    this.#allowedOrigins = [...allowedOrigins];
    this.#firstParty = new FirstPartyOrigins(this.#allowedOrigins);
    this.#block = opts.blockWrites === true;
  }

  async arm(page: Page): Promise<void> {
    this.#page = page;
    if (typeof page.route !== "function") {
      // A page that cannot be routed (a test double, a closed context): write observation is
      // unavailable, and the classifier reports inconclusive rather than a false `prepared`.
      this.#observation = "unavailable";
      return;
    }
    // Count first-party writes ourselves, then let the guard (armed second, so it runs first) abort
    // them when `blockWrites` is set — a blocked write never reaches this handler.
    await page.route("**/*", this.#handler);
    if (!this.#block) return;
    const guard = new ReadOnlyGuard(this.#classifier, { allowlist: this.#allowedOrigins, navigationWrites: "abort" });
    await guard.arm(page);
    guard.beginAction(); // the whole run is the action window
    this.#guard = guard;
  }

  async #route(route: Route, request: Request): Promise<void> {
    const isWrite = this.#classifier({
      method: request.method(),
      path: pathOf(request.url()),
      contentType: request.headers()["content-type"] ?? null,
    });
    if (isWrite && this.#firstParty.thirdParty(request.url(), request.headers()) === null) this.#writes += 1;
    await route.fallback().catch(() => undefined);
  }

  counts(): HandbackWriteCounts {
    return {
      writes: this.#writes,
      writesBlocked: this.#guard?.blockedTotal ?? 0,
      observation: this.#observation,
    };
  }

  async disarm(): Promise<void> {
    const page = this.#page;
    this.#page = undefined;
    await this.#guard?.disarm().catch(() => undefined);
    this.#guard = undefined;
    if (page !== undefined && typeof page.unroute === "function") await page.unroute("**/*", this.#handler).catch(() => undefined);
  }
}

/** A request URL's path, or the URL itself when unparseable. */
function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

/**
 * §4: the classifier facts from a finished run. A failed step pinned to a `postcondition failed:`
 * message is a `verification-failed`; every other premature end is `incomplete`.
 */
export function handbackFacts(a: { readonly result: JourneyRunResult; readonly steps: number; readonly counts: HandbackWriteCounts }): HandbackFacts {
  const at = "at" in a.result ? a.result.at : undefined;
  const reason = "reason" in a.result ? a.result.reason : undefined;
  const failedKind: HandbackFacts["failedKind"] = at === undefined ? undefined : /postcondition failed/.test(reason ?? "") ? "postcondition" : "other";
  return {
    outcome: a.result.outcome,
    // `at` is the run's 0-based step index; `failedAt` names the step as a person counts it (1-based,
    // as the run's own "step N failed" reason does).
    ...(at === undefined ? {} : { failedAt: at + 1 }),
    ...(failedKind === undefined ? {} : { failedKind }),
    steps: a.steps,
    checksPassed: a.result.outcome === "ok" ? a.steps : at ?? 0,
    writes: a.counts.writes,
    writesBlocked: a.counts.writesBlocked,
    writeObservation: a.counts.observation,
  };
}

/**
 * §4: attach the typed `handback` result to a run's result — only when the Journey declares a
 * boundary. A Journey without one is returned byte-identical to before.
 */
export function attachHandback(
  result: JourneyRunResult,
  journey: Journey,
  counts: HandbackWriteCounts,
): JourneyRunResult & { handback?: HandbackOutcome } {
  const boundary = journey.metadata.boundary;
  if (boundary === undefined) return result;
  const facts = handbackFacts({ result, steps: flatJourneySteps(journey).length, counts });
  return { ...result, handback: classifyHandback(facts, boundary) };
}

/**
 * #583 §4: a run's exit with its handback state applied — `prepared` keeps the run's own code,
 * `submitted` and a failed or incomplete handback are 1 (never a pass), `inconclusive` is 2.
 */
export function handbackExitCode(runCode: number, handback: HandbackOutcome | undefined): number {
  if (handback === undefined || handback.state === "prepared") return runCode;
  if (handback.state === "inconclusive") return Math.max(runCode, 2);
  return runCode === 0 ? 1 : runCode;
}

/** #583 §4: the one human line a run with a boundary ends with — the next step only when prepared. */
export function handbackLine(handback: HandbackOutcome): string {
  if (handback.state === "prepared") return `handback: prepared — next: ${handback.nextStep ?? `${handback.stopBefore} is yours`}`;
  const at = handback.evidence.failedAt === undefined ? "" : ` at step ${handback.evidence.failedAt}`;
  if (handback.state === "submitted") return `handback: submitted — ${handback.evidence.writes + handback.evidence.writesBlocked} write(s) were sent during the run; nothing is prepared for a person`;
  return `handback: ${handback.state}${at} — nothing is ready for ${handback.stopBefore}`;
}
