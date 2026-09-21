import type { Locator, Page } from "playwright";

export class Target {
  private constructor(
    readonly description: string,
    private readonly finder: (page: Page) => Locator,
  ) {}

  static named(description: string): { locatedBy(finder: (page: Page) => Locator): Target } {
    return { locatedBy: (finder) => new Target(description, finder) };
  }

  resolve(page: Page): Locator {
    return this.finder(page);
  }
}
