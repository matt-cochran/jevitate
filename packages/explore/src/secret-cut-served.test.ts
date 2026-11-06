import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { perceive } from "./perceive.js";
import { snapshot } from "./snapshot.js";
import { captureAria } from "./action-delta.js";
import { monitorFor } from "./page-monitor.js";
import { maskPageReads, readFormText, readInProgressStatus, readPageStatus } from "./status.js";
import { withSession, useSkippingTime } from "./testkit.js";

/** A secret across any bound leaves none of its characters: the mask comes before the cut, on every field the model reads. */
const SECRET = "Qx7StraddleSecretVal9";
const pad = (n: number): string => "w".repeat(n);
/** Every 4-character piece of the secret: a cut leaves one of these if it came first. */
const pieces = Array.from({ length: SECRET.length - 3 }, (_, i) => SECRET.slice(i, i + 4));
/** What a model reads. A descriptor is a control's identity for replay: it never goes in a prompt, and writers mask it. */
const readByModel = (v: unknown): string => JSON.stringify(v, (k, x: unknown) => (k === "descriptor" || k === "target" ? undefined : x));
const clean = (v: unknown): void => {
  const json = readByModel(v);
  for (const p of pieces) expect(json).not.toContain(p);
};

const PAGE = (): string => {
  // Each bound, with the secret starting a few characters before it, at several offsets.
  const offs = [3, 7, 11, 15];
  const rows = offs.flatMap((o) => [
    `<select aria-label="plan ${o}"><option value="a">${pad(200 - o)}${SECRET}</option></select>`,
    `<section aria-label="${pad(60 - o)}${SECRET}"><button>in region ${o}</button></section>`,
    `<h3>${pad(120 - o)}${SECRET}</h3><button>under heading ${o}</button>`,
    `<button>${pad(200 - o)}${SECRET}</button>`,
    `<div role="listbox"><div role="option">${pad(200 - o)}${SECRET}</div></div>`,
  ]);
  return `<!doctype html><title>t</title><h1>Cuts</h1>${rows.join("")}`;
};

let server: Server;
let origin: string;
beforeAll(async () => {
  server = createServer((_q, r) => r.writeHead(200, { "content-type": "text/html" }).end(PAGE()));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => {
  server.closeAllConnections();
  server.close();
});

describe("mask before cut", () => {
  useSkippingTime();
  it("a snapshot's options, region labels, headings and names", async () => {
    await withSession("secret-cut", async (session) => {
      await session.page.goto(`${origin}/`);
      const snap = await snapshot(session.page, { secrets: [SECRET], maxCandidates: 200 });
      clean(snap.controls);
      expect(readByModel(snap.controls)).toContain("«redacted»");
      // The cuts themselves still hold.
      for (const c of snap.controls) {
        expect((c.heading ?? "").length).toBeLessThanOrEqual(120);
        for (const o of c.options ?? []) expect(o.length).toBeLessThanOrEqual(200);
      }
    });
  });

  it("a perception", async () => {
    await withSession("secret-cut", async (session) => {
      await session.page.goto(`${origin}/`);
      clean(await perceive(session.page, { secrets: [SECRET], maxCandidates: 200 }));
    });
  });

  it("an announcement is read past its cut, so the reader's mask sees the whole value", async () => {
    await withSession("secret-cut", async (session) => {
      await session.page.addInitScript(() => {
        (window as unknown as { __jevitateDeltasOn?: boolean }).__jevitateDeltasOn = true;
      });
      const monitor = monitorFor(session.page);
      await session.page.goto(`${origin}/`);
      const since = Date.now();
      await session.page.evaluate((text) => {
        const el = document.createElement("div");
        el.setAttribute("role", "status");
        el.textContent = text;
        document.body.append(el);
      }, `${pad(195)}${SECRET}`);
      const notes = await monitor.transientsSince(since);
      if (notes.length > 0) expect(notes.some((n) => n.text.includes(SECRET))).toBe(true);
    });
  });

  it("status reads: alerts, in-progress lines, form text", async () => {
    await withSession("secret-cut", async (session) => {
      maskPageReads(session.page, [SECRET]);
      await session.page.setContent(
        [3, 7, 11, 15].flatMap((o) => [`<div role="alert">${pad(200 - o)}${SECRET}</div>`]).join("") +
          `<div role="status">Processing ${pad(80 - 11 - 5)}${SECRET}</div><form><button id="in">x</button><p>${pad(200 - 5)}${SECRET}</p></form>`,
      );
      const status = await readPageStatus(session.page);
      expect(status.alerts.length).toBeGreaterThan(0);
      clean(status);
      for (const a of status.alerts) expect(a.length).toBeLessThanOrEqual(201);
      const job = await readInProgressStatus(session.page);
      expect(job).not.toBeNull();
      clean(job);
      const form = await readFormText(session.page.locator("#in"));
      expect(form).not.toBeNull();
      clean(form);
    });
  });

  it("the action-delta capture's size cut falls between lines", async () => {
    await withSession("secret-cut", async (session) => {
      await session.page.setContent(`<main>${Array.from({ length: 9000 }, (_, i) => `<p>row ${i} ${pad(40)} ${SECRET}</p>`).join("")}</main>`);
      clean(await captureAria(session.page, { secrets: [SECRET], learned: new Set() }));
    });
  });
});
