import type { Question } from "./core.js";
import { BrowseTheWebToken } from "./browse-the-web.js";
import type { Target } from "./target.js";

export const TextOf = {
  target(target: Target): Question<string> {
    return {
      description: `text of ${target.description}`,
      async answeredBy(actor) {
        const page = actor.ability(BrowseTheWebToken).session.page;
        return target.resolve(page).innerText();
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
