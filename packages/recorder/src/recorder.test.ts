import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { PlaywrightBrowserPort } from "@doit/playwright";
import { Recorder, type ActionCaptureEvent, type CaptureEvent } from "./recorder.js";

const port = new PlaywrightBrowserPort();

/**
 * The fixture is served through `page.route` interception rather than
 * `page.setContent`: `setContent` is implemented as `document.open()` +
 * `document.write()`, and `document.open()` removes every event listener
 * registered on the document (and on the window), which silently unhooks the
 * listener our init script installed. A real navigation is both faithful to
 * how the recorder is used and the only way to exercise the transport.
 */
const FIXTURE_URL = "http://doit.test/recorder-fixture";

async function withRecorder(
  html: string,
  body: (ctx: { recorder: Recorder; page: import("playwright").Page }) => Promise<void>,
): Promise<void> {
  const profileDir = await mkdtemp(join(tmpdir(), "doit-recorder-"));
  const session = await port.open({ profileDir, headless: true, allowedOrigins: [], baseUrl: "about:blank" });
  try {
    const recorder = new Recorder(session);
    await recorder.install();
    await session.page.route("**/*", (route) =>
      route.fulfill({ contentType: "text/html", body: `<!doctype html><html><body>${html}</body></html>` }),
    );
    await session.page.goto(FIXTURE_URL);
    await body({ recorder, page: session.page });
  } finally {
    await session.close();
    await rm(profileDir, { recursive: true, force: true });
  }
}

const isAction = (e: CaptureEvent): e is ActionCaptureEvent => e.type === "action";
const actions = (recorder: Recorder): ActionCaptureEvent[] => recorder.events.filter(isAction);

async function waitUntil(label: string, predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test(
  "captures real click/input/change/keydown/submit events into the Node-side buffer with stable eids",
  async () => {
    const html = `
      <form id="form" onsubmit="event.preventDefault()">
        <label for="name">Name</label>
        <input id="name" type="text" />
        <button id="go" type="submit"><span id="go-label">Go</span></button>
      </form>`;

    await withRecorder(html, async ({ recorder, page }) => {
      await page.locator("#name").fill("Ada");
      await page.locator("#name").press("Tab");
      await page.locator("#go-label").click();

      await waitUntil("the first click and submit", () =>
        actions(recorder).some((a) => a.payload.kind === "click") &&
        actions(recorder).some((a) => a.payload.kind === "submit"),
      );

      // Acting on the same element again must reuse its eid, not mint a new one.
      await page.locator("#go-label").click();
      await waitUntil(
        "the second click",
        () => actions(recorder).filter((a) => a.payload.kind === "click").length === 2,
      );

      const captured = actions(recorder);
      const kinds = new Set(captured.map((a) => a.payload.kind));
      expect(kinds).toEqual(new Set(["input", "change", "keydown", "click", "submit"]));

      const byKind = (kind: string): ActionCaptureEvent[] => captured.filter((a) => a.payload.kind === kind);

      // Three distinct elements were acted on: the input, the button, the form.
      const eids = new Set(captured.map((a) => a.payload.eid));
      expect(eids.size).toBe(3);

      // Every event on the text input shares one eid; both clicks share one eid.
      const inputEids = new Set([...byKind("input"), ...byKind("change"), ...byKind("keydown")].map((a) => a.payload.eid));
      expect(inputEids.size).toBe(1);
      const clickEids = new Set(byKind("click").map((a) => a.payload.eid));
      expect(clickEids.size).toBe(1);
      expect([...inputEids][0]).not.toBe([...clickEids][0]);

      const inputEvent = byKind("input")[0]!;
      expect(inputEvent.payload.tag).toBe("input");
      expect(inputEvent.payload.typeAttr).toBe("text");
      expect(inputEvent.payload.rawText).toBe("Ada");

      // keydown is captured for timing only: it must never carry content.
      const keydown = byKind("keydown")[0]!;
      expect("rawText" in keydown.payload).toBe(false);

      const click = byKind("click")[0]!;
      expect(click.payload.tag).toBe("button");
      expect(click.payload.rawText).toBe("Go");

      const submit = byKind("submit")[0]!;
      expect(submit.payload.tag).toBe("form");

      for (const a of captured) {
        expect(a.frameUrl).toBe(FIXTURE_URL);
        expect(typeof a.payload.ts).toBe("number");
        expect(typeof a.receivedAt).toBe("number");
      }

      // Navigation is captured Node-side, not by the injected script.
      const navigations = recorder.events.filter((e) => e.type === "navigation");
      expect(navigations.some((n) => n.type === "navigation" && n.url === FIXTURE_URL)).toBe(true);
    });
  },
  120_000,
);

test(
  "never lets password, one-time-code or otp values leave the browser",
  async () => {
    const passwordSecret = "hunter2-never-leaves";
    const oneTimeCodeSecret = "424242";
    const otpSecret = "313131-otp-never-leaves";
    // The autocomplete values are deliberately upper-case: the match must be
    // case-insensitive, and "one-time-code" does not contain "otp", so each
    // spelling needs its own clause in the in-page predicate.
    const html = `
      <form onsubmit="event.preventDefault()">
        <input id="pw" type="password" />
        <input id="one-time" type="text" autocomplete="ONE-TIME-CODE" />
        <input id="otp" type="text" autocomplete="OTP" />
        <input id="plain" type="text" />
      </form>`;

    await withRecorder(html, async ({ recorder, page }) => {
      await page.locator("#pw").fill(passwordSecret);
      await page.locator("#one-time").fill(oneTimeCodeSecret);
      await page.locator("#otp").fill(otpSecret);
      await page.locator("#plain").fill("visible-ok");

      await waitUntil(
        "all four fields filled",
        () => new Set(actions(recorder).map((a) => a.payload.eid)).size === 4,
      );

      const captured = actions(recorder);
      // Identify each field by the eid the injected script actually tagged it
      // with, read back from the live DOM.
      const eidFor = async (selector: string): Promise<string> => {
        const eid = await page.locator(selector).getAttribute("data-doit-eid");
        expect(eid, `${selector} was never tagged`).not.toBeNull();
        return eid!;
      };
      const eventsFor = (eid: string): ActionCaptureEvent[] =>
        captured.filter((a) => a.payload.eid === eid);

      // Every secret-marked field: the rawText key is literally absent.
      for (const selector of ["#pw", "#one-time", "#otp"]) {
        const events = eventsFor(await eidFor(selector));
        expect(events.length, `no events captured for ${selector}`).toBeGreaterThan(0);
        for (const event of events) {
          expect("rawText" in event.payload, `${selector} leaked a rawText key`).toBe(false);
        }
      }

      // The unmarked field still carries its value, so the test is not vacuous.
      const plainEvents = eventsFor(await eidFor("#plain"));
      expect(plainEvents.some((e) => e.payload.rawText === "visible-ok")).toBe(true);

      // Suppressing the value does not suppress the action or its metadata.
      expect(eventsFor(await eidFor("#pw")).every((e) => e.payload.typeAttr === "password")).toBe(true);

      // The load-bearing guarantee: the raw secrets are nowhere in Node.
      const everything = JSON.stringify(recorder.events);
      expect(everything).not.toContain(passwordSecret);
      expect(everything).not.toContain(oneTimeCodeSecret);
      expect(everything).not.toContain(otpSecret);
    });
  },
  120_000,
);

test(
  "ignores events on our own recorder UI and does not tag or count those elements",
  async () => {
    const html = `
      <div data-doit-recorder>
        <button id="ours"><span>Recorder UI</span></button>
      </div>
      <button id="theirs">Page button</button>`;

    await withRecorder(html, async ({ recorder, page }) => {
      await page.locator("#ours").click();
      await page.waitForTimeout(250);
      expect(actions(recorder)).toEqual([]);
      expect(await page.locator("#ours").getAttribute("data-doit-eid")).toBeNull();

      await page.locator("#theirs").click();
      await waitUntil("the page button click", () => actions(recorder).length > 0);

      const captured = actions(recorder);
      expect(captured.length).toBe(1);
      expect(captured[0]!.payload.tag).toBe("button");
      expect(captured[0]!.payload.rawText).toBe("Page button");
      // The excluded click consumed no eid from the page-global counter.
      expect(captured[0]!.payload.eid).toBe("1");
    });
  },
  120_000,
);
