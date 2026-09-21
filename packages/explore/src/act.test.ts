import { describe, it, expect } from "vitest";
import { BrowseTheWeb, CastActor } from "@jevitate/screenplay";
import { act, snapshot } from "./index.js";
import { withSession, LOGIN_FIXTURE_HTML } from "./testkit.js";

const ORIGIN = "http://127.0.0.1:1";

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
