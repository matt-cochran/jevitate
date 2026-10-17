import { describe, expect, it } from "vitest";
import type { Page } from "playwright";
import { PlaywrightBrowserPort } from "@jevitate/playwright";
import { useSkippingTime } from "../../explore/src/testkit.js";
import { Recorder, type AuthoringRecording } from "./recorder.js";

// #304: Node and page time skip idle waits; assertions unchanged.
useSkippingTime({ per: "all" });

/**
 * #564 served: a password field with NO autocomplete and no credential-looking name, behind a
 * "show password" toggle that flips `type` to `text`. The keystrokes typed after the flip are no
 * longer secret by the field's attributes alone, so the page reads their value — but the step was
 * already a hand-back, and its value must never reach `stopAuthoring().values` (which `jevitate
 * record` persists to the take file) nor the Recording. And the reverse (text → password): once
 * any event on a field is secret, the field's step is a hand-back with no value entry.
 */

const port = new PlaywrightBrowserPort();
const ORIGIN = "http://jevitate.test";
const SECRET = "hunter2-SECRET-xyz";

const APP = `
  <form onsubmit="event.preventDefault()">
    <label for="f1">Sesame</label><input id="f1" type="password">
    <button type="button" id="show" onclick="document.getElementById('f1').type='text'">Show</button>
    <label for="f2">Phrase</label><input id="f2" type="text">
    <button type="button" id="hide" onclick="document.getElementById('f2').type='password'">Hide</button>
    <label for="k">Key</label><input id="k" name="apiKey" type="text">
    <label for="other">Nickname</label><input id="other" type="text">
  </form>`;

async function recordAuthoring(act: (page: Page) => Promise<void>, changes: number): Promise<AuthoringRecording> {
  const session = await port.open({ headless: true, allowedOrigins: [], baseUrl: "about:blank" });
  try {
    const recorder = new Recorder(session, "secret-toggle-fixture");
    await recorder.install();
    await session.page.route("**/*", (route) =>
      route.fulfill({ contentType: "text/html", body: `<!doctype html><html><body>${APP}</body></html>` }),
    );
    await session.page.goto(`${ORIGIN}/app`);
    await recorder.start();
    await act(session.page);
    // Every blur-time `change` reaches Node over the binding a moment later: wait for them all.
    const seen = (): number =>
      recorder.events.filter((e) => e.type === "action" && e.payload.kind === "change").length;
    for (let i = 0; i < 250 && seen() < changes; i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return await recorder.stopAuthoring();
  } finally {
    await session.close();
  }
}

describe("a show-password toggle never leaks the password into the take's values (#564, real Chromium)", () => {
  it("password → text with no autocomplete: the step stays a hand-back and gets no values entry", async () => {
    const { recording, values } = await recordAuthoring(async (page) => {
      await page.locator("#f1").pressSequentially(SECRET.slice(0, 4));
      await page.locator("#show").click();
      await page.locator("#f1").click();
      await page.locator("#f1").pressSequentially(SECRET.slice(4));
      await page.locator("#other").click();
    }, 2);
    expect(JSON.stringify([...values])).not.toContain(SECRET.slice(4));
    expect(values.size).toBe(0);
    expect(JSON.stringify(recording)).not.toContain(SECRET.slice(4));
    const kinds = recording.pages.flatMap((p) => p.steps).map((s) => s.step.kind);
    expect(kinds).toContain("handback");
    expect(kinds).not.toContain("fill");
  });

  it("text → password: once any event is secret, the step is a hand-back with no values entry", async () => {
    const { recording, values } = await recordAuthoring(async (page) => {
      await page.locator("#f2").pressSequentially(SECRET.slice(0, 6));
      await page.locator("#hide").click();
      await page.locator("#f2").click();
      await page.locator("#f2").pressSequentially(SECRET.slice(6));
      await page.locator("#other").click();
    }, 2);
    expect(JSON.stringify([...values])).not.toContain(SECRET.slice(0, 6));
    expect(values.size).toBe(0);
    const kinds = recording.pages.flatMap((p) => p.steps).map((s) => s.step.kind);
    expect(kinds).toContain("handback");
    expect(kinds).not.toContain("fill");
  });

  it("a credential-named field (name=apiKey, no type/autocomplete marker) is recorded as a hand-back with no value", async () => {
    const { recording, values } = await recordAuthoring(async (page) => {
      await page.locator("#k").fill(SECRET);
      await page.locator("#other").click();
    }, 1);
    expect(values.size).toBe(0);
    expect(JSON.stringify(recording)).not.toContain(SECRET);
    expect(recording.pages.flatMap((p) => p.steps).map((s) => s.step.kind)).toContain("handback");
  });
});
