import { describe, expect, it } from "vitest";
import { startAccuracyLab } from "../../../test/fixtures/accuracy-lab/app.mjs";

/**
 * #644: behavioral checks for the seeded-defect accuracy lab fixture (test/fixtures/accuracy-lab).
 * Each test proves ONE distinguishing behaviour of one variant over plain HTTP — the same public
 * `data-testid` hooks and status codes a browser run would see — so the lab can't silently drift
 * into no longer seeding the defect its ground truth claims.
 *
 * The fixture's exported `startAccuracyLab` binds 127.0.0.1:0; nothing here touches the disk. No
 * timers are needed: `fetch` resolves when the response arrives, and `close` when the server drains.
 */

const start = async (variant: string) => {
  const app = await startAccuracyLab({ variant, port: 0 });
  return app;
};

const putProfile = (url: string) =>
  fetch(`${url}/api/profile`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Ada Byron", email: "ada.byron@example.com" }),
  });

const confirmationSections = (html: string): number => (html.match(/data-testid="import-extra-\d+"/g) ?? []).length;

describe("accuracy-lab fixture variants", () => {
  it("clean accepts a profile save", async () => {
    const app = await start("clean");
    try {
      const res = await putProfile(app.url);
      expect(res.status).toBe(200);
    } finally {
      await app.close();
    }
  });

  it("j1-5xx rejects a profile save", async () => {
    const app = await start("j1-5xx");
    try {
      const res = await putProfile(app.url);
      expect(res.status).toBe(500);
    } finally {
      await app.close();
    }
  });

  it("j2-stall's contacts page issues no message request", async () => {
    const app = await start("j2-stall");
    try {
      const html = await (await fetch(`${app.url}/contacts`)).text();
      expect(html).not.toMatch(/\/api\/messages/);
    } finally {
      await app.close();
    }
  });

  it("j3-effort renders three extra confirmation sections", async () => {
    const app = await start("j3-effort");
    try {
      const html = await (await fetch(`${app.url}/import`)).text();
      expect(confirmationSections(html)).toBe(3);
    } finally {
      await app.close();
    }
  });

  it("j3-deadend disables the final import control", async () => {
    const app = await start("j3-deadend");
    try {
      const html = await (await fetch(`${app.url}/import`)).text();
      expect(html).toMatch(/data-testid="import-confirm" disabled/);
    } finally {
      await app.close();
    }
  });

  it("j2-phantom answers a send with success but lists no sent message afterwards", async () => {
    const app = await start("j2-phantom");
    try {
      await fetch(`${app.url}/api/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ to: "grace@example.com", body: "Hello" }) });
      const html = await (await fetch(`${app.url}/contacts`)).text();
      expect(html).not.toMatch(/data-testid="sent-row"/);
    } finally {
      await app.close();
    }
  });

  it("j3-phantom answers an import with success but lists no imported contact afterwards", async () => {
    const app = await start("j3-phantom");
    try {
      await fetch(`${app.url}/api/import`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ contacts: [{ name: "Ada Byron", email: "ada@example.com" }] }) });
      const html = await (await fetch(`${app.url}/contacts`)).text();
      expect(html).not.toContain("ada@example.com");
    } finally {
      await app.close();
    }
  });
});
