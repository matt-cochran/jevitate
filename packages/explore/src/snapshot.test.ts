import { describe, it, expect } from "vitest";
import { snapshot, targetCandidates } from "./index.js";
import { withSession, LOGIN_FIXTURE_HTML, INBOX_FIXTURE_HTML } from "./testkit.js";

describe("snapshot — perceive: indexed controls + durable descriptors + freshness", () => {
  it(
    "enumerates visible interactive controls with a durable descriptor and a stable index each",
    async () => {
      await withSession("explore-snapshot-", async (session) => {
        await session.page.setContent(LOGIN_FIXTURE_HTML);
        const snap = await snapshot(session.page);

        // Username, Password, Sign in button, help link — 4 controls.
        const names = snap.controls.map((c) => c.name);
        expect(names).toContain("Username");
        expect(names).toContain("Sign in");

        // Indices are 0..n-1 in order.
        expect(snap.controls.map((c) => c.index)).toEqual(snap.controls.map((_, i) => i));

        // Every control has a usable descriptor.
        for (const c of snap.controls) {
          const d = c.descriptor;
          expect(Boolean(d.testId || d.role || d.label || d.text || d.css)).toBe(true);
        }

        // The Username textbox resolves by role+name.
        const username = snap.controls.find((c) => c.name === "Username");
        expect(username?.role).toBe("textbox");
        expect(username?.descriptor).toMatchObject({ role: "textbox", name: "Username" });
      });
    },
    120_000,
  );

  it(
    "the freshness signature is stable within a state and changes on navigation",
    async () => {
      await withSession("explore-snapshot-sig-", async (session) => {
        await session.page.setContent(LOGIN_FIXTURE_HTML);
        const a1 = await snapshot(session.page);
        const a2 = await snapshot(session.page);
        expect(a2.signature).toBe(a1.signature); // same state -> same signature

        await session.page.setContent(INBOX_FIXTURE_HTML);
        const b = await snapshot(session.page);
        expect(b.signature).not.toBe(a1.signature); // new state -> new signature
      });
    },
    120_000,
  );

  it(
    "never reads a password field's value into the control summary",
    async () => {
      await withSession("explore-snapshot-secret-", async (session) => {
        await session.page.setContent(LOGIN_FIXTURE_HTML);
        await session.page.getByLabel("Password").fill("hunter2");
        const snap = await snapshot(session.page);
        const dump = JSON.stringify(snap);
        expect(dump).not.toContain("hunter2");
      });
    },
    120_000,
  );

  it(
    "never reads a revealed password / one-time-code field's value (autocomplete marker), but still reads ordinary fields",
    async () => {
      await withSession("explore-snapshot-marker-", async (session) => {
        // A "show password" toggle flips type to text; autocomplete still marks it.
        await session.page.setContent(`<!doctype html><html><body>
          <label>Password <input type="text" autocomplete="current-password" value="shown-pw-111" /></label>
          <label>New password <input type="text" autocomplete="new-password" value="new-pw-222" /></label>
          <label>Code <input type="text" autocomplete="one-time-code" value="otp-333" /></label>
          <label for="ta">Notes</label><textarea id="ta" autocomplete="one-time-code"></textarea>
          <label>City <input type="text" autocomplete="address-level2" value="Springfield" /></label>
        </body></html>`);
        await session.page.locator("#ta").fill("ta-otp-444");
        const snap = await snapshot(session.page);
        const dump = JSON.stringify(snap);
        for (const v of ["shown-pw-111", "new-pw-222", "otp-333", "ta-otp-444"]) {
          expect(dump).not.toContain(v);
        }
        // Non-secret control values are still perceived (the gate is not "read nothing").
        expect(snap.controls.find((c) => c.name === "City")?.summary).toContain('value="Springfield"');
      });
    },
    120_000,
  );

  it(
    "caps retained candidates at maxCandidates and flags truncation",
    async () => {
      await withSession("explore-snapshot-cap-", async (session) => {
        const many = `<!doctype html><html><body>${Array.from(
          { length: 6 },
          (_, i) => `<button type="button">B${i}</button>`,
        ).join("")}</body></html>`;
        await session.page.setContent(many);
        const snap = await snapshot(session.page, { maxCandidates: 3 });
        expect(snap.controls.length).toBe(3);
        expect(snap.truncated).toBe(true);
      });
    },
    120_000,
  );

  it(
    "#182: same-named controls are told apart in the offered actions by their named dialog and position",
    async () => {
      await withSession("explore-snapshot-scope-", async (session) => {
        await session.page.setContent(`<input aria-label="Source URL" value="https://example.com">
<button id="a">Analyze</button>
<div role="alertdialog" aria-label="Confirm analysis"><p>This analysis uses credits.</p>
<button>Analyze</button><button>Cancel</button></div>`);
        const snap = await snapshot(session.page);
        const analyze = snap.controls.filter((c) => c.name === "Analyze");
        expect(analyze.map((c) => c.scope)).toEqual([null, 'alertdialog "Confirm analysis"']);
        const offered = targetCandidates(snap.controls).filter((c) => c.control.name === "Analyze").map((c) => c.description);
        expect(offered).toEqual([
          'click button "Analyze" outside any dialog (1 of 2)',
          'click button "Analyze" in alertdialog "Confirm analysis" (2 of 2)',
        ]);
        // A unique control's description is untouched.
        expect(targetCandidates(snap.controls).find((c) => c.control.name === "Cancel")?.description).toBe('click button "Cancel"');
      });
    },
    120_000,
  );
});

