import { expect, test } from "vitest";
import { PlaywrightBrowserPort } from "@jevitate/playwright";
import { RecordingSchema, type RecordedStep, type Step } from "@jevitate/recording";
import { Recorder, type ActionCaptureEvent, type CaptureEvent } from "./recorder.js";

const port = new PlaywrightBrowserPort();

/** Every fixture is served from this origin, whatever the path. */
const ORIGIN = "http://jevitate.test";
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
  const session = await port.open({ headless: true, allowedOrigins: [], baseUrl: "about:blank" });
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
  "never lets password, one-time-code, otp or autocomplete-password values leave the browser",
  async () => {
    const passwordSecret = "hunter2-never-leaves";
    const oneTimeCodeSecret = "424242";
    const otpSecret = "313131-otp-never-leaves";
    const shownPasswordSecret = "toggled-visible-never-leaves";
    const newPasswordSecret = "brand-new-never-leaves";
    // The autocomplete values are deliberately upper-case: the match must be
    // case-insensitive, and "one-time-code" does not contain "otp", so each
    // spelling needs its own clause in the in-page predicate.
    //
    // `#shown-pw` and `#new-pw` are `type="text"` on purpose: that is exactly
    // what a "show password" toggle produces (it flips the input's `type`
    // between `password` and `text`), and what a page that masks a text field
    // in JS ships from the start. The `type` check alone misses both; only
    // the `autocomplete`-contains-"password" clause catches them.
    const html = `
      <form onsubmit="event.preventDefault()">
        <input id="pw" type="password" />
        <input id="one-time" type="text" autocomplete="ONE-TIME-CODE" />
        <input id="otp" type="text" autocomplete="OTP" />
        <input id="shown-pw" type="text" autocomplete="CURRENT-PASSWORD" />
        <input id="new-pw" type="text" autocomplete="new-password" />
        <input id="plain" type="text" />
      </form>`;

    await withRecorder(html, async ({ recorder, page }) => {
      await page.locator("#pw").fill(passwordSecret);
      await page.locator("#one-time").fill(oneTimeCodeSecret);
      await page.locator("#otp").fill(otpSecret);
      await page.locator("#shown-pw").fill(shownPasswordSecret);
      await page.locator("#new-pw").fill(newPasswordSecret);
      await page.locator("#plain").fill("visible-ok");

      await waitUntil(
        "all six fields filled",
        () => new Set(actions(recorder).map((a) => a.payload.eid)).size === 6,
      );

      const captured = actions(recorder);
      // Identify each field by the eid the injected script actually tagged it
      // with, read back from the live DOM.
      const eidFor = async (selector: string): Promise<string> => {
        const eid = await page.locator(selector).getAttribute("data-jevitate-eid");
        expect(eid, `${selector} was never tagged`).not.toBeNull();
        return eid!;
      };
      const eventsFor = (eid: string): ActionCaptureEvent[] =>
        captured.filter((a) => a.payload.eid === eid);

      // Every secret-marked field: the rawText key is literally absent.
      for (const selector of ["#pw", "#one-time", "#otp", "#shown-pw", "#new-pw"]) {
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
      expect(everything).not.toContain(shownPasswordSecret);
      expect(everything).not.toContain(newPasswordSecret);
    });
  },
  120_000,
);

test(
  "ignores events on our own recorder UI and does not tag or count those elements",
  async () => {
    const html = `
      <div data-jevitate-recorder>
        <button id="ours"><span>Recorder UI</span></button>
      </div>
      <button id="theirs">Page button</button>`;

    await withRecorder(html, async ({ recorder, page }) => {
      await page.locator("#ours").click();
      await page.waitForTimeout(250);
      expect(actions(recorder)).toEqual([]);
      expect(await page.locator("#ours").getAttribute("data-jevitate-eid")).toBeNull();

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

/**
 * Slack for the cross-step `atMs` monotonicity check (see its call site,
 * "Timing is present on every step and sensible"). Generous enough to absorb
 * realistic wall-clock jitter between two processes' `Date.now()` reads under
 * heavy CPU/VM-scheduling contention (the observed flake was ~49ms), while
 * being far too small to hide a genuine step-ordering regression, which shows
 * up as steps landing hundreds of ms apart or on the wrong page entirely.
 */
const MONOTONICITY_JITTER_TOLERANCE_MS = 100;

/** Kinds the Recorder computes a descriptor for; mirrors its own NEEDS_DESCRIPTOR. */
const DESCRIBED_KINDS: ReadonlySet<string> = new Set(["click", "input", "change"]);

/**
 * Waits until every action captured so far has been described.
 *
 * Descriptions are computed in parallel with the demonstration and cost
 * hundreds of milliseconds of DOM round trips, so a test that drives the page
 * at machine speed and then asserts on descriptors is asserting on a race — and
 * one that is lost under load, which is how this first showed up. A human
 * demonstrating a journey pauses between actions; this is that pause, made a
 * condition instead of a guess. A trailing `change` fires on blur and so
 * arrives after the action that caused it, hence the small settle first.
 */
async function describedSoFar(recorder: Recorder, page: import("playwright").Page): Promise<void> {
  await page.waitForTimeout(150);
  await waitUntil("every captured action to be described", () =>
    actions(recorder).every(
      (a) => !DESCRIBED_KINDS.has(a.payload.kind) || a.resolution !== undefined,
    ),
  );
}
const ACTING_KINDS: ReadonlySet<string> = new Set(["click", "fill", "select", "handback", "navigate"]);

test(
  "stop() assembles a schema-valid Recording: redacted fills, a handback for the secret field, pages split on navigation, a postcondition on every acting step",
  async () => {
    const secret = "pw-never-recorded-31337";

    await withSite(LOGIN_JOURNEY, async ({ recorder, page }) => {
      await recorder.start("sign in and open the inbox");
      await page.goto(`${ORIGIN}/login`);
      await page.getByLabel("Username").fill("jane");
      await describedSoFar(recorder, page);
      await page.getByLabel("Password").fill(secret);
      await describedSoFar(recorder, page);
      await page.getByRole("button", { name: "Sign in" }).click();
      await page.waitForURL(/\/inbox$/);
      await page.getByRole("button", { name: "Refresh" }).click();
      await describedSoFar(recorder, page);

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
        // The stable `name` attribute is captured as the replay anchor (never the value).
        target: { role: "textbox", name: "Username", anchor: { name: "u" } },
        value: { redacted: true, length: 4 },
        expect: { kind: "visible", target: { role: "textbox", name: "Username", anchor: { name: "u" } } },
      });

      // 6. The secret field is a handback, not a fill/select: no value, no
      //    length, no RedactedValue of any kind anywhere in that step.
      const handback = login[2]!;
      expect(handback.kind).toBe("handback");
      if (handback.kind !== "handback") throw new Error("expected a handback step");
      // The secret field's anchor is its `name` attribute — an identifier, never its value.
      expect(handback.resume).toEqual({ kind: "visible", target: { label: "Password", anchor: { name: "p" } } });
      expect(handback.prompt.length).toBeGreaterThan(0);
      const serializedHandback = JSON.stringify(handback);
      for (const forbidden of ["redacted", '"value"', '"length"', String(secret.length)]) {
        expect(serializedHandback, `handback step leaked ${forbidden}`).not.toContain(forbidden);
      }

      // 7. The navigating click's postcondition is the URL it produced —
      //    whatever kind of step it ended up as. That it is a real `click`
      //    rather than a handback is the dedicated test's business (see "a
      //    click that navigates is still recorded as a real click"); what this
      //    end-to-end assembly test pins is that either way the navigation is
      //    folded into its postcondition rather than emitted as a step.
      const navigating = login[3]!;
      const postcondition = navigating.kind === "handback" ? navigating.resume : (navigating as { expect: unknown }).expect;
      expect(postcondition).toEqual({ kind: "urlIncludes", text: "/inbox" });
      expect(login.length).toBe(4);

      // 8. A click with no navigation falls back to "the acted target is visible".
      expect(inbox).toEqual([
        {
          kind: "click",
          target: { role: "button", name: "Refresh", anchor: { id: "refresh" } },
          expect: { kind: "visible", target: { role: "button", name: "Refresh", anchor: { id: "refresh" } } },
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
      //     at 0 with no gap, and atMs never goes backwards (beyond ordinary
      //     wall-clock jitter — see MONOTONICITY_JITTER_TOLERANCE_MS below).
      const timings = recording.pages.flatMap((p) => p.steps.map((s) => s.timing!));
      expect(timings.every((t) => t !== undefined)).toBe(true);
      expect(timings[0]!.atMs).toBe(0);
      expect(timings[0]!.gapBeforeMs).toBe(0);
      for (const [i, t] of timings.entries()) {
        expect(t.gapBeforeMs).toBeGreaterThanOrEqual(0);
        expect(t.durationMs).toBeGreaterThanOrEqual(0);
        // `atMs` is derived from real `Date.now()` reads taken in two different
        // processes (the browser page for actions, Node for the leading
        // navigation) and stitched together in event-arrival order. `Date.now()`
        // is wall-clock, not monotonic: under full-suite PARALLEL load (heavy
        // CPU contention across worker processes/VM scheduling), a pair of
        // close-in-time reads can occasionally disagree by tens of ms without
        // any real steps having been recorded out of order — this is exactly
        // what was observed flaking (e.g. "expected 0 to be greater than or
        // equal to 49"). A genuine assembly bug (steps landing on the wrong
        // page/element, an out-of-order capture) produces a structural failure
        // the *other* dedicated tests in this file catch directly (e.g. "never
        // lets a resolution that outlived its document describe an element of
        // the NEXT one"), not a small numeric wobble here. So this check keeps
        // asserting real monotonicity (still ordering, not a measured-latency
        // threshold) while tolerating small same-direction noise from mixing
        // two processes' wall clocks under contention.
        if (i > 0) {
          expect(t.atMs).toBeGreaterThanOrEqual(timings[i - 1]!.atMs - MONOTONICITY_JITTER_TOLERANCE_MS);
        }
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
      await describedSoFar(recorder, page);

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
      expect(select.target).toEqual({ role: "combobox", name: "Mode", anchor: { name: "m" } });
      expect(select.value).toEqual({ redacted: true, length: 4 });
      expect(select.expect).toEqual({ kind: "visible", target: { role: "combobox", name: "Mode", anchor: { name: "m" } } });

      // The checkbox produced click + input + change; only the click is a step.
      expect(steps[3]).toEqual({
        kind: "click",
        target: { label: "Remember me", anchor: { name: "r" } },
        expect: { kind: "visible", target: { label: "Remember me", anchor: { name: "r" } } },
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
        await describedSoFar(recorder, page);

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
  "a click that navigates is still recorded as a real click: its facts were captured in-page, synchronously, before the document went away",
  async () => {
    // This replaces Task 5's "KNOWN LIMITATION" test, which characterized the
    // opposite behaviour. A click on a submit button starts a navigation at
    // once, and the new document commits in tens of milliseconds — far sooner
    // than Node can finish the DOM round trips a description used to need
    // (measured at 700-2100ms), so the step degraded to a `handback`. The fix
    // reads the element's facts inside the capture listener, in the same tick
    // as the click and before the browser's default action runs, so there is
    // nothing left to race: the facts are always the pre-navigation element's.
    //
    // This is the one step a login journey cannot do without, so "a real
    // `click` on Sign in" is the assertion that matters, not "some step".
    await withSite(LOGIN_JOURNEY, async ({ recorder, page }) => {
      await recorder.start();
      await page.goto(`${ORIGIN}/login`);
      await page.getByRole("button", { name: "Sign in" }).click();
      await page.waitForURL(/\/inbox$/);
      await page.waitForTimeout(250);

      const recording = await recorder.stop();
      expect(recording.pages.map((p) => p.url)).toEqual(["/login", "/inbox"]);

      const steps = stepsOf(recording.pages[0]!.steps);
      expect(steps.map((s) => s.kind)).toEqual(["navigate", "click"]);
      // A real, replayable click — and the navigation it caused is still folded
      // into its postcondition rather than emitted as a step of its own.
      expect(steps[1]).toEqual({
        kind: "click",
        target: { role: "button", name: "Sign in" },
        expect: { kind: "urlIncludes", text: "/inbox" },
      });
      expect(stepsOf(recording.pages[1]!.steps)).toEqual([]);
    });
  },
  120_000,
);

test(
  "when the document has moved on, the descriptor is trusted from the captured facts alone: stability capped one notch, no alternates",
  async () => {
    // The other half of the fix, asserted where it is observable. Live
    // validation (does this selector resolve to exactly this node?) genuinely
    // needs the document to still exist, so it is best-effort: skipped once the
    // page has demonstrably moved on. What the recorder reports then must say
    // so — the top facts-derived candidate, one notch less stable because
    // nothing corroborated it, and no alternates because nothing else was
    // corroborated either.
    await withSite(LOGIN_JOURNEY, async ({ recorder, page }) => {
      await recorder.start();
      await page.goto(`${ORIGIN}/login`);
      await page.getByRole("button", { name: "Sign in" }).click();
      await page.waitForURL(/\/inbox$/);
      await page.getByRole("button", { name: "Refresh" }).click();
      await describedSoFar(recorder, page);

      const clicks = actions(recorder).filter((a) => a.payload.kind === "click");
      expect(clicks.length).toBe(2);

      // The navigating click: unvalidated, so `high` (an ungenerated role+name)
      // is reported as `medium`, and the text/css rungs that were never proven
      // are not offered as alternates.
      const navigating = clicks[0]!.resolution;
      expect(navigating?.ok).toBe(true);
      if (navigating?.ok !== true) throw new Error("expected the navigating click to be described");
      expect(navigating.descriptor).toEqual({ role: "button", name: "Sign in" });
      expect(navigating.stability).toBe("medium");
      expect(navigating.alternates).toEqual([]);

      // The click that changed nothing: validated against the live page, so it
      // keeps its full stability and carries the lower rungs that also proved
      // out. Without this the test could pass by capping everything.
      const settled = clicks[1]!.resolution;
      expect(settled?.ok).toBe(true);
      if (settled?.ok !== true) throw new Error("expected the settled click to be described");
      expect(settled.descriptor).toEqual({ role: "button", name: "Refresh", anchor: { id: "refresh" } });
      expect(settled.stability).toBe("high");
      expect(settled.alternates.length).toBeGreaterThan(0);

      await recorder.stop();
    });
  },
  120_000,
);

test(
  "never lets a resolution that outlived its document describe an element of the NEXT one",
  async () => {
    // The nastiest failure this recorder can have, and the only one that is
    // worse than a handback: `eid`s restart at 1 in every document, so the
    // doomed `[data-jevitate-eid="1"]` query left over from the page we just left
    // can match a DIFFERENT element that the NEW page has since tagged 1. The
    // description then succeeds — against the wrong element, on the wrong page
    // — and is written onto the previous page's step. It parses, it replays,
    // and it clicks the wrong thing.
    //
    // Task 5b moved the goalposts in the right direction: the facts now come
    // from the capture handler, so /login's click is described correctly rather
    // than handed back — but the *validation* query is still the one that can
    // stray onto /inbox, so the guard it is checking is still load-bearing, and
    // the wrong answer it must never produce is still "Refresh".
    //
    // The fixture forces the collision rather than hoping for it: /inbox clicks
    // a button from a load-time script, so the new document mints eid 1 within
    // milliseconds of committing, while the /login click's query is still
    // polling.
    await withSite(
      {
        "/login": `<form method="post" action="/inbox"><button type="submit">Sign in</button></form>`,
        "/inbox": `<h1>Inbox</h1><button type="button" id="auto">Refresh</button>
                   <script>document.getElementById('auto').click()</script>`,
      },
      async ({ recorder, page }) => {
        await recorder.start();
        await page.goto(`${ORIGIN}/login`);
        await page.getByRole("button", { name: "Sign in" }).click();
        await page.waitForURL(/\/inbox$/);
        await page.waitForTimeout(750);

        // Non-vacuity first, from the raw capture buffer rather than from the
        // assembled output: two clicks, on two different documents, that the
        // page numbered identically. That is the collision, and asserting it
        // here means this test cannot quietly pass by never setting one up.
        const clicks = actions(recorder).filter((a) => a.payload.kind === "click");
        expect(clicks.map((c) => c.payload.eid)).toEqual(["1", "1"]);
        expect(clicks.map((c) => new URL(c.frameUrl).pathname)).toEqual(["/login", "/inbox"]);

        const recording = await recorder.stop();
        expect(recording.pages.map((p) => p.url)).toEqual(["/login", "/inbox"]);

        // The load-bearing assertion: /login's step must not have borrowed the
        // element /inbox tagged 1. Describing it as "Refresh" would be a lie
        // about which button was clicked, and one that parses, replays and
        // clicks the wrong thing. It is described as the button that was
        // actually clicked — from facts read before /inbox existed — and the
        // capped stability says out loud that nothing on a live page proved it.
        const login = stepsOf(recording.pages[0]!.steps);
        const diagnostic = JSON.stringify(
          clicks.map((c) => ({ url: c.frameUrl, resolution: c.resolution })),
        );
        expect(login.map((s) => s.kind), diagnostic).toEqual(["navigate", "click"]);
        expect(JSON.stringify(login), diagnostic).not.toContain("Refresh");
        expect(login[1], diagnostic).toEqual({
          kind: "click",
          target: { role: "button", name: "Sign in" },
          expect: { kind: "urlIncludes", text: "/inbox" },
        });
        expect(clicks[0]!.resolution, diagnostic).toMatchObject({ ok: true, stability: "medium" });

        // /inbox's own click is described normally — the guard rejects the
        // cross-document borrow, not the new page's genuine action.
        expect(stepsOf(recording.pages[1]!.steps), diagnostic).toEqual([
          {
            kind: "click",
            target: { role: "button", name: "Refresh", anchor: { id: "auto" } },
            expect: { kind: "visible", target: { role: "button", name: "Refresh", anchor: { id: "auto" } } },
          },
        ]);
      },
    );
  },
  120_000,
);

// === Authoring value side-channel (RxD Phase A.3a, Task 1) ===

test(
  "stopAuthoring() retains the real value for a non-secret field only, correlated to its exact step, while .recording stays fully redacted and stop() is unaffected",
  async () => {
    const secret = "pw-never-recorded-77331";

    await withSite(LOGIN_JOURNEY, async ({ recorder, page }) => {
      await recorder.start();
      await page.goto(`${ORIGIN}/login`);
      await page.getByLabel("Username").fill("jane");
      await describedSoFar(recorder, page);
      await page.getByLabel("Password").fill(secret);
      await describedSoFar(recorder, page);
      await page.getByRole("button", { name: "Sign in" }).click();
      await page.waitForURL(/\/inbox$/);
      await page.getByRole("button", { name: "Refresh" }).click();
      await describedSoFar(recorder, page);

      const { recording, values } = await recorder.stopAuthoring();

      // 1. `.recording` looks exactly like what `stop()` produces for the same
      //    buffer (same shapes the dedicated assembly test already pins).
      expect(recording.pages.map((p) => p.url)).toEqual(["/login", "/inbox"]);
      const login = stepsOf(recording.pages[0]!.steps);
      expect(login[1]).toEqual({
        kind: "fill",
        // The stable `name` attribute is captured as the replay anchor (never the value).
        target: { role: "textbox", name: "Username", anchor: { name: "u" } },
        value: { redacted: true, length: 4 },
        expect: { kind: "visible", target: { role: "textbox", name: "Username", anchor: { name: "u" } } },
      });
      expect(login[2]!.kind).toBe("handback");

      // 2. The load-bearing redaction guarantee, unchanged: no captured value
      //    anywhere in the serialized artifact, secret or otherwise.
      const serializedRecording = JSON.stringify(recording);
      expect(serializedRecording).not.toContain("jane");
      expect(serializedRecording).not.toContain(secret);

      // 3. `values` has exactly one entry: the username field's real,
      //    pre-redaction value, keyed to page 0 / step 1 — the fill step
      //    asserted above (`${pageIndex}:${stepIndexInPage}`).
      expect(values.size).toBe(1);
      expect(values.get("0:1")).toBe("jane");

      // 4. No entry at all for the secret field — not an empty string, not
      //    under any other key — and the raw secret is nowhere in the map.
      expect([...values.values()]).not.toContain(secret);
      expect([...values.values()].some((v) => v.includes(secret))).toBe(false);

      // 5. `stop()` is unaffected by `stopAuthoring()` having already run: the
      //    identical redacted Recording comes back (regression check).
      const plainRecording = await recorder.stop();
      expect(plainRecording).toEqual(recording);
    });
  },
  120_000,
);

// === Task 1: TargetDescriptor ordinal ===

test(
  "clicking one of two identical <button>OK</button>s records which match it was, via role+name plus ordinal, instead of falling to a fragile css path",
  async () => {
    const html = `<div id="row"><button>OK</button><button>OK</button></div>`;

    await withRecorder(html, async ({ recorder, page }) => {
      await recorder.start();
      await page.locator("button").nth(0).click();
      await page.locator("button").nth(1).click();
      await describedSoFar(recorder, page);

      const clicks = actions(recorder).filter((a) => a.payload.kind === "click");
      expect(clicks.length).toBe(2);
      const [firstClick, secondClick] = clicks;

      const first = firstClick!.resolution;
      const second = secondClick!.resolution;
      if (first?.ok !== true || second?.ok !== true) {
        throw new Error("expected both identical-button clicks to be described");
      }

      // Neither role+name nor text is unique on its own — both buttons say
      // "OK" — so each click's descriptor is corroborated with `ordinal`
      // recording *which* match was acted on, rather than falling all the
      // way down to a generated css nth-of-type selector.
      expect(first.descriptor).toEqual({ role: "button", name: "OK", ordinal: 0, candidates: 2 });
      expect(second.descriptor).toEqual({ role: "button", name: "OK", ordinal: 1, candidates: 2 });

      const recording = await recorder.stop();
      expect(() => RecordingSchema.parse(recording)).not.toThrow();
      const steps = stepsOf(recording.pages[0]!.steps);
      expect(steps[0]).toMatchObject({ kind: "click", target: { role: "button", name: "OK", ordinal: 0 } });
      expect(steps[1]).toMatchObject({ kind: "click", target: { role: "button", name: "OK", ordinal: 1 } });
    });
  },
  120_000,
);
