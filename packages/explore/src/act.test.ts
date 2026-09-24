import { describe, it, expect } from "vitest";
import { BrowseTheWeb, CastActor } from "@jevitate/screenplay";
import { act, snapshot } from "./index.js";
import type { Control } from "./snapshot.js";
import { withSession, LOGIN_FIXTURE_HTML } from "./testkit.js";

const ORIGIN = "http://127.0.0.1:1";

/** A fake `session` shaped exactly like `withSession`'s real one — enough for `act()`'s
 *  `actor.ability(BrowseTheWebToken).session.page` and `monitorFor(page)` (which calls
 *  `page.on(...)` once, lazily, the first time the page is monitored). */
function fakeSessionWithPage(page: any) {
  return { page, startTracing: async () => {}, stopTracingToFile: async () => {}, saveStorageState: async () => {}, admission: undefined, close: async () => {} };
}

/** A minimal, valid `Control` for a button-like target — the fields `act()`/`gate()` read. */
function buttonControl(overrides: Partial<Control> = {}): Control {
  return {
    index: 0,
    descriptor: { css: "#b" },
    stability: "high",
    role: "button",
    name: "Save a card",
    tag: "button",
    inputType: null,
    enabled: true,
    summary: 'button "Save a card"',
    ...overrides,
  };
}

describe("act — execute + actionability gate (Task 7)", () => {
  it(
    "types into a resolved, actionable textbox",
    async () => {
      await withSession("explore-act-type-", async (session) => {
        await session.page.setContent(LOGIN_FIXTURE_HTML);
        const actor = CastActor.named("act").whoCan(new BrowseTheWeb(session, [ORIGIN]));
        const snap = await snapshot(session.page);
        const username = snap.controls.find((c) => c.name === "Username")!;

        const r = await act(actor, { op: "type", control: username, value: "jane" });
        expect(r).toEqual({ ok: true, mutated: true });
        expect(await session.page.getByLabel("Username").inputValue()).toBe("jane");
      });
    },
    120_000,
  );

  it(
    "clicks a resolved, actionable button",
    async () => {
      await withSession("explore-act-click-", async (session) => {
        await session.page.setContent(
          `<!doctype html><html><body><button type="button" id="b" onclick="this.textContent='clicked'">Go</button></body></html>`,
        );
        const actor = CastActor.named("act").whoCan(new BrowseTheWeb(session, [ORIGIN]));
        const snap = await snapshot(session.page);
        const btn = snap.controls[0]!;
        const r = await act(actor, { op: "click", control: btn });
        expect(r.ok).toBe(true);
        expect(await session.page.locator("#b").textContent()).toBe("clicked");
      });
    },
    120_000,
  );

  it(
    "selects an option in a resolved combobox",
    async () => {
      await withSession("explore-act-select-", async (session) => {
        await session.page.setContent(
          `<!doctype html><html><body><label>Colour <select aria-label="Colour"><option value="red">red</option><option value="blue">blue</option></select></label></body></html>`,
        );
        const actor = CastActor.named("act").whoCan(new BrowseTheWeb(session, [ORIGIN]));
        const snap = await snapshot(session.page);
        const combo = snap.controls.find((c) => c.name === "Colour")!;
        const r = await act(actor, { op: "select", control: combo, value: "blue" });
        expect(r.ok).toBe(true);
        expect(await session.page.getByLabel("Colour").inputValue()).toBe("blue");
      });
    },
    120_000,
  );

  it(
    "a failing actionability gate does NOT mutate and surfaces honestly",
    async () => {
      await withSession("explore-act-gate-", async (session) => {
        await session.page.setContent(LOGIN_FIXTURE_HTML);
        const actor = CastActor.named("act").whoCan(new BrowseTheWeb(session, [ORIGIN]));
        const snap = await snapshot(session.page);
        const username = snap.controls.find((c) => c.name === "Username")!;

        // The page changes out from under the (now stale) decision.
        await session.page.setContent(`<!doctype html><html><body><p>gone</p></body></html>`);
        const r = await act(actor, { op: "type", control: username, value: "jane" });
        expect(r.ok).toBe(false);
        expect(r.mutated).toBe(false);
        expect(r.reason).toBeTruthy();
      });
    },
    120_000,
  );

  it(
    "type with no value fails closed (never types a guess)",
    async () => {
      await withSession("explore-act-noval-", async (session) => {
        await session.page.setContent(LOGIN_FIXTURE_HTML);
        const actor = CastActor.named("act").whoCan(new BrowseTheWeb(session, [ORIGIN]));
        const snap = await snapshot(session.page);
        const username = snap.controls.find((c) => c.name === "Username")!;
        const r = await act(actor, { op: "type", control: username, value: null });
        expect(r.ok).toBe(false);
        expect(r.mutated).toBe(false);
      });
    },
    120_000,
  );
});

describe("act — gate never throws on a target that detaches after count() (#77)", () => {
  it("an elementHandle() that times out (element gone the instant after count()) is a failed act, not a throw", async () => {
    const locator = {
      count: async () => 1,
      elementHandle: async () => {
        throw new Error("locator.elementHandle: Timeout 2000ms exceeded.");
      },
    };
    const page: any = { locator: () => locator, on: () => {}, url: () => "http://127.0.0.1:1/" };
    const actor = CastActor.named("act").whoCan(new BrowseTheWeb(fakeSessionWithPage(page), [ORIGIN]));

    await expect(act(actor, { op: "click", control: buttonControl() })).resolves.toEqual(
      expect.objectContaining({ ok: false, mutated: false, reason: expect.stringContaining("target no longer present") }),
    );
  });

  it("isVisible()/isEnabled() throwing on an already-resolved handle (detached moments later) is a failed act, not a throw", async () => {
    const handle = {
      isVisible: async () => {
        throw new Error("Node is detached from document");
      },
      dispose: async () => {},
    };
    const locator = { count: async () => 1, elementHandle: async () => handle };
    const page: any = { locator: () => locator, on: () => {}, url: () => "http://127.0.0.1:1/" };
    const actor = CastActor.named("act").whoCan(new BrowseTheWeb(fakeSessionWithPage(page), [ORIGIN]));

    await expect(act(actor, { op: "click", control: buttonControl() })).resolves.toEqual(
      expect.objectContaining({ ok: false, mutated: false, reason: expect.stringContaining("target no longer present") }),
    );
  });

  it(
    "a real button removed by its own click handler (the issue's minimal repro) never crashes a follow-up act on the same (now-stale) control",
    async () => {
      await withSession("explore-act-detach-", async (session) => {
        await session.page.setContent(
          `<!doctype html><html><body><button id=b onclick="this.replaceWith(Object.assign(document.createElement('div'),{textContent:'form here'}))">Save a card</button></body></html>`,
        );
        const actor = CastActor.named("act").whoCan(new BrowseTheWeb(session, [ORIGIN]));
        const snap = await snapshot(session.page);
        const btn = snap.controls.find((c) => c.name === "Save a card")!;

        const first = await act(actor, { op: "click", control: btn });
        expect(first.ok).toBe(true);

        // The SAME (now-stale) control, re-targeted without a re-snapshot (e.g. an adversarial
        // repeat-rapid strategy) — the button is gone; this must fail closed, fast, never throw.
        const second = await act(actor, { op: "click", control: btn });
        expect(second.ok).toBe(false);
        expect(second.reason).toBeTruthy();
      });
    },
    30_000,
  );
});

describe("act — gate refuses a clipped/offscreen skip link, fast (#75)", () => {
  it(
    "a visually-hidden same-page anchor is refused by the gate instead of burning a click timeout",
    async () => {
      await withSession("explore-act-skiplink-", async (session) => {
        await session.page.setContent(
          `<!doctype html><html><body>
            <a href="#main" style="position:absolute;left:-10000px;top:auto;width:1px;height:1px;overflow:hidden">Skip to content</a>
            <nav><a href="/a">A</a> <a href="/b">B</a></nav>
            <main id="main"><button onclick="this.textContent='clicked'">In-page action</button></main>
          </body></html>`,
        );
        const actor = CastActor.named("act").whoCan(new BrowseTheWeb(session, [ORIGIN]));
        const snap = await snapshot(session.page);
        const skip = snap.controls.find((c) => c.name === "Skip to content")!;
        expect(skip).toBeTruthy();

        const start = Date.now();
        const r = await act(actor, { op: "click", control: skip });
        const elapsedMs = Date.now() - start;
        expect(r.ok).toBe(false);
        expect(r.reason).toContain("visually-hidden skip link");
        // Well under Playwright's 30s default — proves no actionability timeout was waited out.
        expect(elapsedMs).toBeLessThan(5_000);

        // The in-page button stays fully actionable — only the skip link is refused.
        const button = snap.controls.find((c) => c.name === "In-page action")!;
        const clicked = await act(actor, { op: "click", control: button });
        expect(clicked.ok).toBe(true);
      });
    },
    30_000,
  );
});
