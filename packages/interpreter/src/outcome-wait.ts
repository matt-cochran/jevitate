import type { Assertion, OutcomeWait } from "@jevitate/recording";
import { WAIT_FOR_STALL_MS } from "@jevitate/recording";
import { BrowseTheWebToken, type Actor } from "@jevitate/screenplay";
import { clock } from "@jevitate/domain";
import { checkAssertion, describeAssertion } from "./assertion.js";
import { descriptorToTarget } from "./descriptor.js";

/** Poll interval without `reload`. */
const WAIT_POLL_MS = 250;
/** Poll interval with `reload` (each poll is a page load). */
const WAIT_RELOAD_POLL_MS = 2_000;
/** After a reload, how long the expectation may take to render before that poll counts as "not yet". */
const AFTER_RELOAD_WINDOW_MS = 5_000;
/** How long one reload may take before that poll counts as "not yet". */
const RELOAD_TIMEOUT_MS = 30_000;

/**
 * #409: one waited step's outcome wait, as the run result reports it. `step` is 1-based (the way
 * `--at-step` counts); `waitedMs` is the time from the first poll to the verdict — a slow job shows
 * up here as a performance signal, not as a flaky pass or fail.
 */
export interface StepWait {
  readonly step: number;
  readonly waitedMs: number;
  readonly maxMs: number;
  /** `held`: the expectation held · `timeout`: `maxMs` passed · `hang`: the progress signal stalled. */
  readonly ending: "held" | "timeout" | "hang";
  readonly polls: number;
  readonly reloads?: number;
  /** For `timeout`/`hang`: why, naming the progress signal for a hang. */
  readonly detail?: string;
}

/** The text a progress assertion's target shows (its "has it changed?" fingerprint), or null. */
async function progressText(actor: Actor, a: Assertion): Promise<string | null> {
  if (!("target" in a)) return a.kind === "urlIncludes" ? actor.ability(BrowseTheWebToken).session.page.url() : null;
  try {
    const locator = descriptorToTarget(a.target).resolve(actor.ability(BrowseTheWebToken).session.page);
    if ((await locator.count()) === 0) return null;
    return await locator.first().innerText({ timeout: 1_000 });
  } catch {
    return null;
  }
}

/**
 * #409: polls `expect` until it holds or `wait.maxMs` passes (reloading the page between polls when
 * `wait.reload`). With `wait.progress`, the progress signal must hold, or its target's text change,
 * at least once per `stallMs`; when it has not for that long the wait ends early as a hang (#328,
 * #330: a job that never progresses ends at the hang threshold, not at the whole budget). Never
 * throws for a check that does not hold — the caller turns a non-`held` ending into a failure.
 */
export async function waitForOutcome(actor: Actor, expect: Assertion, wait: OutcomeWait, step: number): Promise<StepWait> {
  const page = actor.ability(BrowseTheWebToken).session.page;
  const pollMs = wait.pollMs ?? (wait.reload === true ? WAIT_RELOAD_POLL_MS : WAIT_POLL_MS);
  const stallMs = Math.min(wait.stallMs ?? WAIT_FOR_STALL_MS, wait.maxMs);
  const startedAt = clock.monotonicMs();
  const elapsed = (): number => clock.monotonicMs() - startedAt;
  let polls = 0;
  let reloads = 0;
  let lastAliveAt = startedAt;
  let lastText: string | null | undefined;
  const result = (ending: StepWait["ending"], detail?: string): StepWait => ({
    step,
    waitedMs: elapsed(),
    maxMs: wait.maxMs,
    ending,
    polls,
    ...(wait.reload === true ? { reloads } : {}),
    ...(detail === undefined ? {} : { detail }),
  });
  for (;;) {
    const pollStartedAt = clock.monotonicMs();
    let reloadedOk = true;
    if (wait.reload === true && polls > 0) {
      reloads += 1;
      reloadedOk = await page.reload({ waitUntil: "load", timeout: RELOAD_TIMEOUT_MS }).then(
        () => true,
        () => false,
      );
    }
    polls += 1;
    const window = wait.reload === true && polls > 1 && reloadedOk ? Math.min(AFTER_RELOAD_WINDOW_MS, Math.max(0, wait.maxMs - elapsed())) : 0;
    if (reloadedOk && (await checkAssertion(actor, expect, { timeoutMs: window }))) return result("held");
    if (wait.progress !== undefined) {
      const holds = await checkAssertion(actor, wait.progress, { timeoutMs: 0 });
      const text = await progressText(actor, wait.progress);
      const changed = lastText !== undefined && text !== null && text !== lastText;
      lastText = text;
      if (holds || changed) lastAliveAt = clock.monotonicMs();
      const stalledMs = clock.monotonicMs() - lastAliveAt;
      if (stalledMs >= stallMs) {
        return result(
          "hang",
          `hang: the progress signal (${describeAssertion(wait.progress)}) was absent and unchanged for ${(stalledMs / 1000).toFixed(1)}s (stallMs ${stallMs}) after ${(elapsed() / 1000).toFixed(1)}s of waiting`,
        );
      }
    }
    if (elapsed() >= wait.maxMs) return result("timeout", `waited ${(elapsed() / 1000).toFixed(1)}s (waitFor maxMs ${wait.maxMs}); it never held`);
    // The next poll starts `pollMs` after this one started (a reload and its render window included).
    await clock.sleep(Math.max(1, Math.min(pollStartedAt + pollMs - clock.monotonicMs(), wait.maxMs - elapsed())));
  }
}
