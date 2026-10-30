/**
 * #742 — the bounded FIRST-navigation retry. A direct target can refuse the first navigation (a
 * transient DNS or connect hiccup, a navigation timeout, a browser launch failure) before any action
 * or write, even while the origin answers a plain HTTP probe with 200. This wraps ONLY the first
 * navigation: once the seed is loaded the run acts, so nothing here ever retries an action, and the
 * bound is paid once at the start.
 *
 * Every attempt is bounded and recorded (`StartupAttempt`) — index, error class, plain-words redacted
 * reason, and `clock.now()` timings — so a run's `attempts[]` is real evidence of what each try did.
 * Backoff between tries runs on `clock`, and `startupRetryBudgetMs` proves the worst case
 * (`maxAttempts × perAttemptTimeoutMs + (maxAttempts - 1) × backoffMs`) stays within 60s.
 *
 * A seed load cut short by the opt-in navigation guard is a departure, never an unreachable target:
 * it is recorded once and rethrown immediately, never retried (see `blocked-navigation.ts`).
 */

import { clock, type StartupAttempt, type StartupAttemptErrorClass } from "@jevitate/domain";
import type { OriginReadiness } from "@jevitate/playwright";
import { BrowseTheWebToken, tryAbility, type Actor } from "@jevitate/screenplay";
import { peekBlockedDeparture } from "./blocked-navigation.js";
import { describeUnreachable, startupErrorClass } from "./mission-failure.js";

/** How the bounded first-navigation retry is configured. Defaults stay inside the 60s bound. */
export interface StartupRetryPolicy {
  /** Total navigation tries, at least 1. The first try counts, so `1` means "no retry". */
  readonly maxAttempts: number;
  /** Bound on ONE navigation's `goto` (Playwright's own timeout for that try). */
  readonly perAttemptTimeoutMs: number;
  /** Clock wait after a failed try, before the next. */
  readonly backoffMs: number;
}

/** A short, bounded policy: 3 tries × 15s + 2 × 0.5s = 46s worst case, under the 60s bound. */
export const DEFAULT_STARTUP_RETRY: StartupRetryPolicy = Object.freeze({
  maxAttempts: 3,
  perAttemptTimeoutMs: 15_000,
  backoffMs: 500,
});

/** The whole startup retry must fit inside this even in the worst case. */
export const STARTUP_RETRY_BUDGET_MS = 60_000;

/** The worst-case wall time a policy can take: `maxAttempts × bound + (maxAttempts - 1) × backoff`. */
export function startupRetryBudgetMs(policy: StartupRetryPolicy): number {
  return policy.maxAttempts * policy.perAttemptTimeoutMs + (policy.maxAttempts - 1) * policy.backoffMs;
}

/** Every attempt failed; carries the last error and the recorded `attempts[]` for `attempts[]`. */
export class StartupRetryExhaustedError extends Error {
  override readonly name = "StartupRetryExhaustedError";
  readonly attempts: readonly StartupAttempt[];
  override readonly cause: unknown;
  constructor(cause: unknown, attempts: readonly StartupAttempt[]) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.attempts = attempts;
    this.cause = cause;
  }
}

export interface StartupRetryOptions {
  /** Overrides for {@link DEFAULT_STARTUP_RETRY}; the merged policy must stay within the budget. */
  readonly policy?: Partial<StartupRetryPolicy>;
  /**
   * Testing seam: the one navigation an attempt performs. Defaults to the actor's page
   * `goto(url, { timeout: policy.perAttemptTimeoutMs })`.
   */
  readonly navigate?: () => Promise<void>;
  /**
   * The origin's HTTP readiness, used to class a browser failure beside a healthy origin as
   * `origin-readiness`. Defaults to the actor's session `probeOriginReadiness` when it has one.
   */
  readonly probeOriginReadiness?: (url: string) => Promise<OriginReadiness>;
  /** Called once per attempt as it finishes, so a caller can fold each into its run's `attempts[]`. */
  readonly onAttempt?: (attempt: StartupAttempt) => void;
}

function messageOf(e: unknown): string {
  return e instanceof Error ? (e.message.split("\n")[0] ?? e.message) : String(e);
}

function defaultNavigate(actor: Actor, url: string, timeoutMs: number): () => Promise<void> {
  return async () => {
    await actor.ability(BrowseTheWebToken).session.page.goto(url, { timeout: timeoutMs });
  };
}

/**
 * #742: the attempts the last first-navigation retry recorded for an actor. The retry is a seed
 * concern, so it hands its evidence to the run result through this accessor rather than threading a
 * field through every run context; the actor is the run's identity and is held for the run's life.
 */
const attemptsByActor = new WeakMap<Actor, readonly StartupAttempt[]>();

/** The attempts the last {@link navigateWithStartupRetry} recorded for `actor` (oldest first), or `[]`. */
export function startupAttemptsFor(actor: Actor): readonly StartupAttempt[] {
  return attemptsByActor.get(actor) ?? [];
}

/**
 * Navigates to `url` with a bounded retry over transient startup failures. Returns the recorded
 * `attempts[]` (the last one successful) on success; throws `StartupRetryExhaustedError` with its
 * `attempts[]` when every try failed. A guard-blocked departure is recorded once and rethrown
 * unchanged — never retried, never reported as an unreachable target.
 */
export async function navigateWithStartupRetry(
  actor: Actor,
  url: string,
  options: StartupRetryOptions = {},
): Promise<readonly StartupAttempt[]> {
  const policy: StartupRetryPolicy = { ...DEFAULT_STARTUP_RETRY, ...options.policy };
  if (!Number.isInteger(policy.maxAttempts) || policy.maxAttempts < 1) {
    throw new RangeError(`startup retry maxAttempts must be a positive integer, got ${JSON.stringify(policy.maxAttempts)}`);
  }
  const budget = startupRetryBudgetMs(policy);
  if (budget > STARTUP_RETRY_BUDGET_MS) {
    throw new RangeError(`startup retry worst case ${budget}ms exceeds the ${STARTUP_RETRY_BUDGET_MS}ms bound`);
  }

  const session = tryAbility(actor, BrowseTheWebToken)?.session;
  const page = session?.page;
  const probe = options.probeOriginReadiness ?? session?.probeOriginReadiness?.bind(session);
  const navigate = options.navigate ?? defaultNavigate(actor, url, policy.perAttemptTimeoutMs);

  // Real network evidence for each try: a refused connection can surface as a bare navigation
  // timeout, and the `requestfailed` errorText is what actually happened on the wire.
  let netErrorText: string | null = null;
  const onRequestFailed = (req: { failure(): { errorText: string } | null }): void => {
    const text = req.failure()?.errorText;
    if (text !== undefined) netErrorText = text;
  };
  page?.on("requestfailed", onRequestFailed);

  const attempts: StartupAttempt[] = [];
  attemptsByActor.set(actor, attempts);
  const record = (attempt: StartupAttempt): void => {
    attempts.push(attempt);
    options.onAttempt?.(attempt);
  };

  try {
    for (let index = 0; index < policy.maxAttempts; index += 1) {
      netErrorText = null;
      const startedAt = clock.now();
      try {
        await navigate();
        record({ index, errorClass: null, message: "", startedAt, endedAt: clock.now() });
        return attempts;
      } catch (e) {
        const message = messageOf(e);
        if (peekBlockedDeparture(actor) !== undefined) {
          // #521: the guard stopped a departure — the page stayed put. Not an unreachable target,
          // and never retried; the mission judges the blocked landing after its settle.
          record({ index, errorClass: "unclassified", message: describeUnreachable(message, netErrorText), startedAt, endedAt: clock.now() });
          throw e;
        }
        let originReady = false;
        if (probe !== undefined) {
          try {
            originReady = (await probe(url)).class === "ready";
          } catch {
            originReady = false;
          }
        }
        const errorClass: StartupAttemptErrorClass = startupErrorClass({ message, netErrorText, originReady });
        record({ index, errorClass, message: describeUnreachable(message, netErrorText), startedAt, endedAt: clock.now() });
        if (index === policy.maxAttempts - 1) throw new StartupRetryExhaustedError(e, attempts);
        await clock.sleep(policy.backoffMs);
      }
    }
    return attempts;
  } finally {
    page?.off("requestfailed", onRequestFailed);
  }
}
