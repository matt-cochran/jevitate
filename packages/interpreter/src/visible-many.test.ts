import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PlaywrightBrowserPort, type BrowserSession } from "@jevitate/playwright";
import { BrowseTheWeb, CastActor, type Actor } from "@jevitate/screenplay";
import { startServer } from "@jevitate/example-site";
import { AssertionSchema, type Assertion } from "@jevitate/recording";
import { checkAssertion } from "./assertion.js";

/**
 * #299 — `visible:testId=X` on a list item (one element per row) must mean "at least one matching
 * element is visible", never a Playwright strict-mode violation that crashes the run.
 */
let site: Awaited<ReturnType<typeof startServer>>;
let session: BrowserSession;
let actor: Actor;

beforeAll(async () => {
  site = await startServer();
  session = await new PlaywrightBrowserPort().open({ headless: true, allowedOrigins: [site.url], baseUrl: site.url });
  actor = CastActor.named("visible-many").whoCan(new BrowseTheWeb(session, [site.url]));
}, 60_000);

afterAll(async () => {
  await session?.close();
  await site?.close();
});

const holds = (a: Assertion): Promise<boolean> => checkAssertion(actor, AssertionSchema.parse(a), { timeoutMs: 0 });

describe("visible over several matching elements (#299)", () => {
  it("holds when several elements match and at least one is visible", async () => {
    await session.page.setContent(
      `<ul><li data-testid="row" hidden>a</li><li data-testid="row">b</li><li data-testid="row">c</li></ul>`,
    );
    await expect(holds({ kind: "visible", target: { testId: "row" } })).resolves.toBe(true);
  });

  it("does not hold (and does not throw) when every match is hidden or none match", async () => {
    await session.page.setContent(`<ul><li data-testid="row" hidden>a</li><li data-testid="row" style="display:none">b</li></ul>`);
    await expect(holds({ kind: "visible", target: { testId: "row" } })).resolves.toBe(false);
    await expect(holds({ kind: "visible", target: { testId: "nope" } })).resolves.toBe(false);
  });

  it("a single visible match still holds", async () => {
    await session.page.setContent(`<p data-testid="one">x</p>`);
    await expect(holds({ kind: "visible", target: { testId: "one" } })).resolves.toBe(true);
  });
});
