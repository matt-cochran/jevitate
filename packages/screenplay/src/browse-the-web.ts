import type { BrowserSession } from "@doit/playwright";
import type { Ability, AbilityToken } from "./core.js";

export class BrowseTheWeb implements Ability {
  readonly kind = "browse-the-web";
  constructor(
    readonly session: BrowserSession,
    readonly allowedOrigins: string[],
  ) {}
}

export const BrowseTheWebToken: AbilityToken<BrowseTheWeb> = { kind: "browse-the-web" };
