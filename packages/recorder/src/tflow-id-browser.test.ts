import { describe, expect, it } from "vitest";
import type { Page } from "playwright";
import { PlaywrightBrowserPort } from "@jevitate/playwright";
import { computeDescriptor, descriptorToLocator, readElementFacts } from "./descriptor.js";

const port = new PlaywrightBrowserPort();

async function withPage<T>(html: string, body: (page: Page) => Promise<T>): Promise<T> {
  const session = await port.open({ headless: true, allowedOrigins: [], baseUrl: "about:blank" });
  try {
    await session.page.setContent(`<!doctype html><html><body>${html}</body></html>`);
    return await body(session.page);
  } finally {
    await session.close();
  }
}

async function describeFirst(html: string) {
  return withPage(html, async (page) => {
    const handle = await page.locator("button").first().elementHandle();
    if (handle === null) throw new Error("no button");
    return computeDescriptor(page, handle);
  });
}

describe("data-tflow-id capture from a real page (#468)", () => {
  it("is recorded on the descriptor beside a testid", async () => {
    const { descriptor } = await describeFirst(`<button data-testid="send" data-tflow-id="invite.send">Send</button>`);
    expect(descriptor.tflowId).toBe("invite.send");
  });

  it("does not change which rung wins", async () => {
    const { descriptor } = await describeFirst(`<button data-testid="send" data-tflow-id="invite.send">Send</button>`);
    expect(descriptor.testId).toBe("send");
  });

  it("records data-testid as the testId attribute", async () => {
    const { descriptor } = await describeFirst(`<button data-testid="send">Send</button>`);
    expect(descriptor.testIdAttr).toBe("data-testid");
  });

  it("reads data-test as the testId attribute when that supplied the id", async () => {
    const facts = await withPage(`<button data-test="send">Send</button>`, (page) =>
      page.locator("button").evaluate(readElementFacts, { generatedPatterns: [], valueNamedInputTypes: ["button", "submit", "reset"] }),
    );
    expect(facts.testIdAttr).toBe("data-test");
  });

  it("an element with only a tflowId is described by its accessible name, not the tflowId", async () => {
    const { descriptor } = await describeFirst(`<button data-tflow-id="invite.send">Send</button>`);
    expect(descriptor).toMatchObject({ role: "button", name: "Send", tflowId: "invite.send" });
  });

  it("an element without a tflowId records none", async () => {
    const { descriptor } = await describeFirst(`<button data-testid="send">Send</button>`);
    expect(descriptor.tflowId).toBeUndefined();
  });
});

describe("resolution never uses tflowId (#468)", () => {
  it("two descriptors differing only by tflowId resolve to the same elements", async () => {
    const counts = await withPage(`<button data-tflow-id="a">Go</button><button data-tflow-id="b">Go</button>`, async (page) => {
      const a = await descriptorToLocator(page, { role: "button", name: "Go", tflowId: "a" }).count();
      const b = await descriptorToLocator(page, { role: "button", name: "Go", tflowId: "b" }).count();
      return [a, b];
    });
    expect(counts).toEqual([2, 2]);
  });

  it("a tflowId naming no element does not stop the descriptor resolving", async () => {
    const count = await withPage(`<button data-testid="send">Send</button>`, (page) =>
      descriptorToLocator(page, { testId: "send", tflowId: "does.not.exist" }).count(),
    );
    expect(count).toBe(1);
  });

  it("a tflowId alone is not a usable locator", async () => {
    const attempt = await withPage(`<button data-tflow-id="a">Go</button>`, async (page) => {
      try {
        descriptorToLocator(page, { tflowId: "a" });
        return "resolved";
      } catch {
        return "refused";
      }
    });
    expect(attempt).toBe("refused");
  });
});
