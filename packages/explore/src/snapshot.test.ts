import { describe, it, expect } from "vitest";
import { snapshot } from "./index.js";
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
});
