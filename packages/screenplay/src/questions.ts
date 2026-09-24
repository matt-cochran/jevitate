import type { Question } from "./core.js";
import { BrowseTheWebToken } from "./browse-the-web.js";
import type { Target } from "./target.js";

/**
 * The rendered text of an element. `null` when the target does not resolve to exactly one element
 * (absent, or ambiguous) or its text cannot be read within a short bound — never Playwright's 30s
 * default wait: text that is not there is an answer ("no"), not an engine failure.
 */
export const TextOf = {
  target(target: Target): Question<string | null> {
    return {
      description: `text of ${target.description}`,
      async answeredBy(actor) {
        const page = actor.ability(BrowseTheWebToken).session.page;
        const locator = target.resolve(page);
        if ((await locator.count()) !== 1) return null;
        try {
          return await locator.innerText({ timeout: 1_000 });
        } catch {
          return null;
        }
      },
    };
  },
};

/**
 * The current VALUE of a form control (input, textarea, select) — what a user entered or chose, not
 * its text content. `null` when the target does not resolve to exactly one element, or that
 * element has no value (it is not a form control): a value that cannot be read never matches.
 */
export const ValueOf = {
  target(target: Target): Question<string | null> {
    return {
      description: `value of ${target.description}`,
      async answeredBy(actor) {
        const page = actor.ability(BrowseTheWebToken).session.page;
        const locator = target.resolve(page);
        if ((await locator.count()) !== 1) return null;
        try {
          return await locator.inputValue({ timeout: 1_000 });
        } catch {
          return null;
        }
      },
    };
  },
};

export const IsVisible = {
  target(target: Target): Question<boolean> {
    return {
      description: `visibility of ${target.description}`,
      async answeredBy(actor) {
        const page = actor.ability(BrowseTheWebToken).session.page;
        return target.resolve(page).isVisible();
      },
    };
  },
};

export const CountOf = {
  target(target: Target): Question<number> {
    return {
      description: `count of ${target.description}`,
      async answeredBy(actor) {
        const page = actor.ability(BrowseTheWebToken).session.page;
        return target.resolve(page).count();
      },
    };
  },
};
