import type { Activity } from "./core.js";
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
            const locator = target.resolve(page);
            const pace = tryAbility(actor, PaceInteractionsToken);
            if (pace && pace.policy.typing) {
              if (pace.policy.thinkBeforeActionMs) await pace.sleep(pace.pacer.think(pace.policy));
              const delays = pace.pacer.typingDelays(value, pace.policy.typing);
              for (let i = 0; i < value.length; i++) {
                await pace.sleep(delays[i]);
                await locator.pressSequentially(value[i], { delay: 0 });
              }
            } else {
              await locator.fill(value);
            }
          },
        };
      },
    };
  },
};
