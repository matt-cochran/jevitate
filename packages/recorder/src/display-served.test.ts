import { describe, expect, it } from "vitest";
import type { Page } from "playwright";
import { PlaywrightBrowserPort } from "@jevitate/playwright";
import type { Recording, TargetDescriptor } from "@jevitate/recording";
import { useSkippingTime } from "../../explore/src/testkit.js";
import { descriptorToLocator } from "./descriptor.js";
import { Recorder } from "./recorder.js";

// #304: Node and page time skip idle waits; assertions unchanged.
useSkippingTime({ per: "all" });

/**
 * #497 served: the human recorder stores each acted element's visible label on the step target as
 * display metadata (never a locator), and never stores a credential field's label.
 */

const port = new PlaywrightBrowserPort();
const ORIGIN = "http://jevitate.test";

const APP = `
  <form onsubmit="event.preventDefault()">
    <label for="email">Email</label><input id="email" type="email" data-testid="contact-email">
    <label for="pw">Password</label><input id="pw" type="password" data-testid="contact-pw">
    <button type="button" data-testid="action-import"><span>Import</span></button>
    <button type="button" data-testid="close" aria-label="Close dialog">×</button>
    <div id="rich" contenteditable="true" data-testid="rich"></div>
    <div id="labelled-rich" contenteditable="true" aria-label="Message" data-testid="labelled-rich"></div>
    <div id="faux" role="textbox" data-testid="faux">draft typed earlier</div>
  </form>`;

/** Records `act` on the served page (served via `page.route`: `setContent` would unhook the listener). */
async function record(act: (page: Page) => Promise<void>): Promise<Recording> {
  const session = await port.open({ headless: true, allowedOrigins: [], baseUrl: "about:blank" });
  try {
    const recorder = new Recorder(session, "display-fixture");
    await recorder.install();
    await session.page.route("**/*", (route) =>
      route.fulfill({ contentType: "text/html", body: `<!doctype html><html><body>${APP}</body></html>` }),
    );
    await session.page.goto(`${ORIGIN}/app`);
    await recorder.start();
    await act(session.page);
    // The action reaches Node over the binding a moment later: wait for it before stopping.
    for (let i = 0; i < 250 && !recorder.events.some((e) => e.type === "action"); i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return await recorder.stop();
  } finally {
    await session.close();
  }
}

function targets(rec: Recording): TargetDescriptor[] {
  return rec.pages.flatMap((p) => p.steps).flatMap((s) => ("target" in s.step ? [s.step.target] : []));
}

describe("the human recorder records a step's visible label (#497, real Chromium)", () => {
  it("a click on a test-id'd button records its role and visible text", async () => {
    const rec = await record((page) => page.locator("[data-testid=action-import] span").click());
    expect(targets(rec)[0]?.display).toEqual({ role: "button", name: "Import" });
  });

  it("the test id stays the locator beside the label", async () => {
    const rec = await record((page) => page.locator("[data-testid=action-import]").click());
    expect(targets(rec)[0]?.testId).toBe("action-import");
  });

  it("an aria-label is the label of an icon button", async () => {
    const rec = await record((page) => page.locator("[data-testid=close]").click());
    expect(targets(rec)[0]?.display?.name).toBe("Close dialog");
  });

  it("a fill records the field's <label> text", async () => {
    const rec = await record((page) => page.locator("#email").fill("ada@example.com"));
    expect(targets(rec)[0]?.display).toEqual({ role: "textbox", name: "Email" });
  });

  // 0.12.0 review M3: typed text never becomes the label.
  it("a fill into a contenteditable element never records the typed text as its label", async () => {
    const rec = await record((page) => page.locator("#rich").fill("typed secret note"));
    expect(JSON.stringify(rec)).not.toContain("typed secret note");
  });

  it("a contenteditable element's aria-label is still its label", async () => {
    const rec = await record((page) => page.locator("#labelled-rich").fill("typed secret note"));
    expect(targets(rec)[0]?.display?.name).toBe("Message");
  });

  it("a role=textbox element's text is never its label", async () => {
    const rec = await record((page) => page.locator("#faux").click());
    expect(targets(rec)[0]?.display).toBeUndefined();
  });

  it("a password field's label is never stored", async () => {
    const rec = await record((page) => page.locator("#pw").fill("hunter22"));
    // A secret field's fill becomes a handback whose resume check names the field: still no label.
    expect(JSON.stringify(rec)).not.toContain('"display"');
  });
});

describe("resolution never uses the display (#497, real Chromium)", () => {
  async function count(d: TargetDescriptor): Promise<number> {
    const session = await port.open({ headless: true, allowedOrigins: [], baseUrl: "about:blank" });
    try {
      await session.page.setContent(`<!doctype html><html><body>${APP}</body></html>`);
      return await descriptorToLocator(session.page, d).count();
    } finally {
      await session.close();
    }
  }

  it("a display naming no element does not stop the descriptor resolving", async () => {
    expect(await count({ testId: "action-import", display: { role: "button", name: "Nothing like this" } })).toBe(1);
  });

  it("a display alone is not a usable locator", async () => {
    await expect(count({ display: { role: "button", name: "Import" } })).rejects.toThrow(/no usable selector/);
  });
});
