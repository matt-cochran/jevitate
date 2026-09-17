import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { PlaywrightBrowserPort } from "@doit/playwright";
import { RecordingSchema, type RecordedStep, type Step } from "@doit/recording";
import { Recorder, type ActionCaptureEvent, type CaptureEvent } from "./recorder.js";

const port = new PlaywrightBrowserPort();

/** Every fixture is served from this origin, whatever the path. */
const ORIGIN = "http://doit.test";
const FIXTURE_URL = `${ORIGIN}/recorder-fixture`;
const SITE = "recorder-fixture";

/**
 * The fixture is served through `page.route` interception rather than
 * `page.setContent`: `setContent` is implemented as `document.open()` +
 * `document.write()`, and `document.open()` removes every event listener
 * registered on the document (and on the window), which silently unhooks the
 * listener our init script installed. A real navigation is both faithful to
 * how the recorder is used and the only way to exercise the transport.
 *
 * `routes` maps a pathname to the `<body>` of the document served for it; an
 * unlisted path falls back to the `"*"` entry. Serving several paths (rather
 * than one) is what lets a test drive a genuine multi-page journey, which is
 * the only way to exercise page segmentation.
 */
async function withSite(
  routes: Readonly<Record<string, string>>,
  body: (ctx: { recorder: Recorder; page: import("playwright").Page }) => Promise<void>,
): Promise<void> {
  const profileDir = await mkdtemp(join(tmpdir(), "doit-recorder-"));
  const session = await port.open({ profileDir, headless: true, allowedOrigins: [], baseUrl: "about:blank" });
  try {
    const recorder = new Recorder(session, SITE);
    await recorder.install();
    await session.page.route("**/*", (route) => {
      const path = new URL(route.request().url()).pathname;
      const html = routes[path] ?? routes["*"] ?? "";
      return route.fulfill({ contentType: "text/html", body: `<!doctype html><html><body>${html}</body></html>` });
    });
    await body({ recorder, page: session.page });
  } finally {
    await session.close();
    await rm(profileDir, { recursive: true, force: true });
  }
}

async function withRecorder(
  html: string,
  body: (ctx: { recorder: Recorder; page: import("playwright").Page }) => Promise<void>,
): Promise<void> {
  await withSite({ "*": html }, async (ctx) => {
    await ctx.page.goto(FIXTURE_URL);
    await body(ctx);
  });
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

// === Recording assembly (Task 5) ===

/**
 * A two-page journey: `/login` posts to `/inbox`, so the click on "Sign in"
 * is followed by a real main-frame navigation. The form uses POST rather than
 * GET on purpose — a GET submission would put every field's value (including
 * the password's) into the navigated URL, and that URL becomes a
 * `PageSegment.url`, which would leak the secret into the recording through
 * the back door.
 */
const LOGIN_BODY = `
  <h1>Sign in</h1>
  <form method="post" action="/inbox">
    <label>Username <input name="u" aria-label="Username" /></label>
    <label>Password <input name="p" type="password" /></label>
    <label>Remember me <input name="r" type="checkbox" /></label>
    <select name="m" aria-label="Mode"><option value="fast">Fast</option><option value="slow">Slow</option></select>
    <button type="submit">Sign in</button>
  </form>`;

const INBOX_BODY = `
  <h1>Inbox</h1>
  <button type="button" id="refresh">Refresh</button>`;

const LOGIN_JOURNEY: Readonly<Record<string, string>> = { "/login": LOGIN_BODY, "/inbox": INBOX_BODY };

const stepsOf = (pageSteps: readonly RecordedStep[]): Step[] => pageSteps.map((s) => s.step);
const ACTING_KINDS: ReadonlySet<string> = new Set(["click", "fill", "select", "handback", "navigate"]);

test(
  "stop() assembles a schema-valid Recording: redacted fills, a handback for the secret field, pages split on navigation, a postcondition on every acting step",
  async () => {
    const secret = "pw-never-recorded-31337";

    await withSite(LOGIN_JOURNEY, async ({ recorder, page }) => {
      await recorder.start("sign in and open the inbox");
      await page.goto(`${ORIGIN}/login`);
      await page.getByLabel("Username").fill("jane");
      await page.getByLabel("Password").fill(secret);
      await page.getByRole("button", { name: "Sign in" }).click();
      await page.waitForURL(/\/inbox$/);
      await page.getByRole("button", { name: "Refresh" }).click();
      await page.waitForTimeout(250);

      const recording = await recorder.stop("went fine");

      // 1. Self-verifying: the assembled artifact parses against A.1's schema.
      expect(() => RecordingSchema.parse(recording)).not.toThrow();
      expect(recording.version).toBe("1.0.0");
      expect(recording.site).toBe(SITE);
      expect(recording.intent).toBe("sign in and open the inbox");
      expect(recording.retro).toBe("went fine");
      expect(typeof recording.startedAtIso).toBe("string");

      // 2. The load-bearing redaction guarantee, asserted against the real
      //    serialized artifact rather than inferred.
      expect(JSON.stringify(recording)).not.toContain(secret);

      // 3. Pages split on navigation, with pathnames as `golden-replay.test.ts`
      //    spells them.
      expect(recording.pages.map((p) => p.url)).toEqual(["/login", "/inbox"]);

      const login = stepsOf(recording.pages[0]!.steps);
      const inbox = stepsOf(recording.pages[1]!.steps);

      // 4. The first navigation is both pages[0].url AND a leading navigate Step.
      expect(login[0]).toEqual({
        kind: "navigate",
        url: "/login",
        expect: { kind: "urlIncludes", text: "/login" },
      });

      // 5. The normal field is a fill, always redacted, length-preserving.
      expect(login[1]).toEqual({
        kind: "fill",
        target: { role: "textbox", name: "Username" },
        value: { redacted: true, length: 4 },
        expect: { kind: "visible", target: { role: "textbox", name: "Username" } },
      });

      // 6. The secret field is a handback, not a fill/select: no value, no
      //    length, no RedactedValue of any kind anywhere in that step.
      const handback = login[2]!;
      expect(handback.kind).toBe("handback");
      if (handback.kind !== "handback") throw new Error("expected a handback step");
      expect(handback.resume).toEqual({ kind: "visible", target: { label: "Password" } });
      expect(handback.prompt.length).toBeGreaterThan(0);
      const serializedHandback = JSON.stringify(handback);
      for (const forbidden of ["redacted", '"value"', '"length"', String(secret.length)]) {
        expect(serializedHandback, `handback step leaked ${forbidden}`).not.toContain(forbidden);
      }

      // 7. The navigating click's postcondition is the URL it produced —
      //    whatever kind of step it ended up as. See the dedicated test below
      //    for why a *navigating* click is currently a handback rather than a
      //    click; either way the navigation is folded into its postcondition
      //    rather than emitted as a step of its own.
      const navigating = login[3]!;
      const postcondition = navigating.kind === "handback" ? navigating.resume : (navigating as { expect: unknown }).expect;
      expect(postcondition).toEqual({ kind: "urlIncludes", text: "/inbox" });
      expect(login.length).toBe(4);

      // 8. A click with no navigation falls back to "the acted target is visible".
      expect(inbox).toEqual([
        {
          kind: "click",
          target: { role: "button", name: "Refresh" },
          expect: { kind: "visible", target: { role: "button", name: "Refresh" } },
        },
      ]);

      // 9. Every acting step carries a postcondition.
      for (const page of recording.pages) {
        for (const { step } of page.steps) {
          expect(ACTING_KINDS.has(step.kind), `unexpected step kind ${step.kind}`).toBe(true);
          if (step.kind === "handback") expect(step.resume).toBeDefined();
          else if ("expect" in step) expect(step.expect).toBeDefined();
          else throw new Error(`acting step ${step.kind} has no postcondition`);
        }
      }

      // 10. Timing is present on every step and sensible: the first step starts
      //     at 0 with no gap, and atMs never goes backwards.
      const timings = recording.pages.flatMap((p) => p.steps.map((s) => s.timing!));
      expect(timings.every((t) => t !== undefined)).toBe(true);
      expect(timings[0]!.atMs).toBe(0);
      expect(timings[0]!.gapBeforeMs).toBe(0);
      for (const [i, t] of timings.entries()) {
        expect(t.gapBeforeMs).toBeGreaterThanOrEqual(0);
        expect(t.durationMs).toBeGreaterThanOrEqual(0);
        if (i > 0) expect(t.atMs).toBeGreaterThanOrEqual(timings[i - 1]!.atMs);
      }
    });
  },
  120_000,
);

test(
  "coalesces the many input/change events of one field into one step, records <select> as a select, and does not double-record a checkbox click",
  async () => {
    await withSite(LOGIN_JOURNEY, async ({ recorder, page }) => {
      await recorder.start();
      await page.goto(`${ORIGIN}/login`);
      // pressSequentially fires one `input` event per character; `blur` then
      // adds a `change`. All of it is one fill step with the final value.
      await page.getByLabel("Username").pressSequentially("ada");
      await page.getByLabel("Mode").selectOption("slow");
      await page.getByLabel("Remember me").check();
      await page.waitForTimeout(250);

      const recording = await recorder.stop();
      const steps = stepsOf(recording.pages[0]!.steps);

      expect(steps.map((s) => s.kind)).toEqual(["navigate", "fill", "select", "click"]);

      const fill = steps[1]!;
      if (fill.kind !== "fill") throw new Error("expected fill");
      // The redacted length matches what was actually typed, once — not once
      // per keystroke, and not the length of an intermediate prefix.
      expect(fill.value).toEqual({ redacted: true, length: 3 });

      const select = steps[2]!;
      if (select.kind !== "select") throw new Error("expected select");
      expect(select.target).toEqual({ role: "combobox", name: "Mode" });
      expect(select.value).toEqual({ redacted: true, length: 4 });
      expect(select.expect).toEqual({ kind: "visible", target: { role: "combobox", name: "Mode" } });

      // The checkbox produced click + input + change; only the click is a step.
      expect(steps[3]).toEqual({
        kind: "click",
        target: { label: "Remember me" },
        expect: { kind: "visible", target: { label: "Remember me" } },
      });
    });
  },
  120_000,
);

test(
  "an action in a sub-frame becomes a handback whose resume falls back to the current URL",
  async () => {
    await withSite(
      {
        "/outer": `<h1>Outer</h1><iframe src="/inner" title="inner"></iframe>`,
        "/inner": `<button type="button">Inner button</button>`,
      },
      async ({ recorder, page }) => {
        await recorder.start();
        await page.goto(`${ORIGIN}/outer`);
        await page.frameLocator("iframe").getByRole("button", { name: "Inner button" }).click();
        await page.waitForTimeout(250);

        const recording = await recorder.stop();
        // Only the main frame's navigation segments the recording; the iframe's
        // own navigation to /inner must not create a PageSegment.
        expect(recording.pages.map((p) => p.url)).toEqual(["/outer"]);

        const steps = stepsOf(recording.pages[0]!.steps);
        expect(steps.map((s) => s.kind)).toEqual(["navigate", "handback"]);
        const handback = steps[1]!;
        if (handback.kind !== "handback") throw new Error("expected handback");
        // No descriptor exists for a sub-frame element, so `resume` falls back
        // to the one assertion that is always constructible.
        expect(handback.resume).toEqual({ kind: "urlIncludes", text: "/outer" });
      },
    );
  },
  120_000,
);

test(
  "KNOWN LIMITATION: a click that navigates cannot be described, so it degrades to a handback that still carries the right postcondition",
  async () => {
    // This characterizes a real limit, it does not endorse it. A click on a
    // submit button starts a navigation at once; the new document commits in
    // tens of milliseconds, while describing the clicked element costs many DOM
    // round trips (measured at 700-2100ms cold). The query lands on the new
    // document, finds no `data-doit-eid`, and there is no descriptor to record.
    //
    // Recording it as a `handback` is the honest degradation: a human is asked
    // to perform the step, and `resume` still says exactly how to tell it
    // worked. What it is NOT is replayable without a human, which is why this
    // is escalated rather than papered over. When the fix lands (capturing the
    // element's facts in-page, synchronously, in the capture listener) this
    // test should fail and be rewritten to assert a `click` step.
    await withSite(LOGIN_JOURNEY, async ({ recorder, page }) => {
      await recorder.start();
      await page.goto(`${ORIGIN}/login`);
      await page.getByRole("button", { name: "Sign in" }).click();
      await page.waitForURL(/\/inbox$/);
      await page.waitForTimeout(250);

      const recording = await recorder.stop();
      expect(recording.pages.map((p) => p.url)).toEqual(["/login", "/inbox"]);

      const steps = stepsOf(recording.pages[0]!.steps);
      expect(steps.map((s) => s.kind)).toEqual(["navigate", "handback"]);
      const handback = steps[1]!;
      if (handback.kind !== "handback") throw new Error("expected handback");
      // The navigation still folds into the step it caused, so the recording
      // knows where the journey went even though it cannot click for itself.
      expect(handback.resume).toEqual({ kind: "urlIncludes", text: "/inbox" });
      // And a click on a button that does NOT navigate is described perfectly
      // well, which is what pins the cause to the navigation and not to
      // buttons, clicks or the descriptor ladder.
      expect(stepsOf(recording.pages[1]!.steps)).toEqual([]);
    });
  },
  120_000,
);
