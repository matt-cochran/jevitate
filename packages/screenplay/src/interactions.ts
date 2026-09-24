import type { Activity, Actor } from "./core.js";
import { BrowseTheWebToken } from "./browse-the-web.js";
import { tryAbility } from "./cast-actor.js";
import { PaceInteractionsToken } from "./pace-interactions.js";
import type { Target } from "./target.js";

export const Navigate = {
  to(path: string): Activity {
    return {
      description: `Navigate to ${path}`,
      async performAs(actor) {
        const page = actor.ability(BrowseTheWebToken).session.page;
        await page.goto(path);
      },
    };
  },
};

export const Click = {
  /**
   * `options.timeout` bounds Playwright's own click (its actionability wait +
   * the click itself) — omit it and Playwright's default (30s) applies,
   * unchanged from before this option existed. A caller with its own
   * pre-click actionability gate (e.g. `@jevitate/explore`'s `act()`) passes a
   * short bound so a target that raced out from under the gate fails fast
   * rather than waiting out the full default.
   */
  on(target: Target, options?: { timeout?: number }): Activity {
    return {
      description: `Click ${target.description}`,
      async performAs(actor) {
        const page = actor.ability(BrowseTheWebToken).session.page;
        await target.resolve(page).click(options);
      },
    };
  },
};

/**
 * Shared fill mechanics for `Enter.theText` and `EnterSecret.theSecret` —
 * identical typing/pacing behavior either way. `value` is held only in this
 * function's own local scope/call stack; callers must never assign it to
 * anything that outlives this call (see `EnterSecret.theSecret`'s doc
 * comment for why that matters for a `Secret`'s plaintext).
 */
async function typeInto(actor: Actor, target: Target, value: string): Promise<void> {
  const page = actor.ability(BrowseTheWebToken).session.page;
  const locator = target.resolve(page);
  const pace = tryAbility(actor, PaceInteractionsToken);
  if (pace && pace.policy.typing) {
    // Clear the field first so paced typing has replace semantics matching
    // the unpaced fill() path below (pressSequentially appends at the caret
    // rather than replacing). Mechanical setup, not a paced delay: no sleep.
    await locator.fill("");
    if (pace.policy.thinkBeforeActionMs) await pace.sleep(pace.pacer.think(pace.policy));
    const delays = pace.pacer.typingDelays(value, pace.policy.typing);
    for (let i = 0; i < value.length; i++) {
      await pace.sleep(delays[i]);
      await locator.pressSequentially(value[i], { delay: 0 });
    }
  } else {
    await locator.fill(value);
  }
}

export const Enter = {
  theText(value: string) {
    return {
      into(target: Target): Activity {
        return {
          description: `Enter "${value}" into ${target.description}`,
          async performAs(actor) {
            await typeInto(actor, target, value);
          },
        };
      },
    };
  },
};

/**
 * A REDACTED sibling of `Enter.theText` for secret values (Hard Floor #6 /
 * §9a invariant #2: a secret's plaintext must never reach an Activity
 * description, since a future logger could print `activity.description`).
 * Takes anything shaped like `@jevitate/secrets`' `Secret` (duck-typed —
 * `@jevitate/screenplay` stays dependency-free of `@jevitate/secrets`, exactly as
 * `@jevitate/secrets` itself duplicates rather than imports `SecretRef`) and
 * calls `.reveal()` exactly once, inline, at the moment of fill — the
 * revealed value is never interpolated into `description` or assigned to
 * anything outside `typeInto`'s own call stack.
 */
export const EnterSecret = {
  theSecret(secret: { reveal(): string }) {
    return {
      into(target: Target): Activity {
        return {
          description: `Enter «secret» into ${target.description}`,
          async performAs(actor) {
            await typeInto(actor, target, secret.reveal());
          },
        };
      },
    };
  },
};
