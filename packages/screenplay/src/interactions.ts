import type { Activity } from "./core.js";
import { BrowseTheWebToken } from "./browse-the-web.js";
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
  on(target: Target): Activity {
    return {
      description: `Click ${target.description}`,
      async performAs(actor) {
        const page = actor.ability(BrowseTheWebToken).session.page;
        await target.resolve(page).click();
      },
    };
  },
};

export const Enter = {
  theText(value: string) {
    return {
      into(target: Target): Activity {
        return {
          description: `Enter "${value}" into ${target.description}`,
          async performAs(actor) {
            const page = actor.ability(BrowseTheWebToken).session.page;
            await target.resolve(page).fill(value);
          },
        };
      },
    };
  },
};
