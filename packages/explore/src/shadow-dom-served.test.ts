import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BrowseTheWeb, CastActor } from "@jevitate/screenplay";
import { act, monitorFor, occluderOf, perceive, snapshot } from "./index.js";
import { withSession, useSkippingTime } from "./testkit.js";

// #304: Node and page time skip idle waits (settle windows, hang ceilings, polls); assertions unchanged.
useSkippingTime({ per: "all" });

/**
 * #357: controls inside an OPEN shadow root (a web component mounted for style isolation) are
 * perceived, labelled, occlusion-checked and clickable like light-DOM controls. A CLOSED shadow root
 * stays out of scope: nothing outside the component can reach into it, so its controls are absent.
 */

/** Defines `<demo-bar>` (open root) and `<sealed-bar>` (closed root), each with one button. */
const COMPONENTS = `<script>
  class Bar extends HTMLElement {
    constructor(mode, label) {
      super();
      const root = this.attachShadow({ mode });
      root.innerHTML = '<style>div{position:fixed;bottom:0;left:0;right:0;padding:8px;background:#222}</style>' +
        '<div><button type="button">' + label + '</button></div>';
      root.querySelector("button").addEventListener("click", (e) => { e.target.textContent = "Pressed"; document.body.dataset.pressed = label; });
    }
  }
  customElements.define("demo-bar", class extends Bar { constructor() { super("open", "Get started"); } });
  customElements.define("sealed-bar", class extends Bar { constructor() { super("closed", "Sealed action"); } });
</script>`;

const PAGES: Record<string, string> = {
  "/open": `<!doctype html><html><body><h1>Shadow</h1><button type="button">Light</button>${COMPONENTS}
    <demo-bar></demo-bar></body></html>`,
  "/closed": `<!doctype html><html><body><h1>Shadow</h1><button type="button">Light</button>${COMPONENTS}
    <sealed-bar></sealed-bar></body></html>`,
  // The ONLY control on the page lives in an open shadow root, mounted late (the render wait sees it).
  "/only-shadow": `<!doctype html><html><body><h1>Shadow</h1>${COMPONENTS}<script>
    setTimeout(() => document.body.appendChild(document.createElement("demo-bar")), 300);
  </script></body></html>`,
  // Two instances of one component: same-named shadow buttons, each must resolve to ITSELF.
  "/twice": `<!doctype html><html><body><plan-card data-plan="basic"></plan-card><plan-card data-plan="pro"></plan-card><script>
    customElements.define("plan-card", class extends HTMLElement { constructor() { super();
      const root = this.attachShadow({ mode: "open" }); root.innerHTML = '<button type="button">Choose</button>';
      root.querySelector("button").addEventListener("click", () => { document.body.dataset.chosen = this.dataset.plan; }); } });
  </script></body></html>`,
  // A light-DOM overlay covers the shadow button: the shared predicate drops it from both.
  "/covered": `<!doctype html><html><body>${COMPONENTS}<demo-bar></demo-bar>
    <div data-testid="overlay" style="position:fixed;inset:0;background:rgba(0,0,0,.4)"><button type="button">Close</button></div>
  </body></html>`,
  // An overlay INSIDE an open shadow root covers a light-DOM button; it is named from inside the root.
  "/shadow-cover": `<!doctype html><html><body><button type="button" id="under">Under</button>
    <cover-host></cover-host><script>
    customElements.define("cover-host", class extends HTMLElement { constructor() { super();
      this.attachShadow({ mode: "open" }).innerHTML = '<div data-testid="shadow-overlay" style="position:fixed;inset:0;background:rgba(0,0,0,.4)"></div>'; } });
  </script></body></html>`,
};

let server: Server;
let origin: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    const body = PAGES[req.url ?? ""];
    if (body === undefined) {
      res.writeHead(404).end("not found");
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (addr === null || typeof addr === "string") throw new Error("server has no port");
  origin = `http://127.0.0.1:${(addr satisfies AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
});

describe("#357 — controls in an open shadow root", () => {
  it("a goal-style snapshot lists the shadow button (named) and act() clicks it", async () => {
    await withSession(
      "shadow-open-",
      async (session) => {
        await session.page.goto(`${origin}/open`, { waitUntil: "domcontentloaded" });
        const snap = await snapshot(session.page, { mentioned: (n) => /get started/i.test(n) });
        expect(snap.controls.map((c) => c.name)).toEqual(["Light", "Get started"]);
        const btn = snap.controls.find((c) => c.name === "Get started")!;
        expect(btn.role).toBe("button");
        expect(btn.summary).toBe('button "Get started"');
        // The descriptor resolves uniquely, through the shadow boundary.
        expect(btn.descriptor).toMatchObject({ role: "button", name: "Get started" });

        const actor = CastActor.named("shadow").whoCan(new BrowseTheWeb(session, [origin]));
        expect(await act(actor, { op: "click", control: btn })).toEqual({ ok: true, mutated: true });
        expect(await session.page.evaluate(() => document.body.dataset.pressed)).toBe("Get started");
      },
      origin,
    );
  });

  it("same-named buttons in two component instances each get a descriptor that resolves to that one", async () => {
    await withSession(
      "shadow-twice-",
      async (session) => {
        await session.page.goto(`${origin}/twice`, { waitUntil: "domcontentloaded" });
        const controls = (await snapshot(session.page)).controls;
        expect(controls.map((c) => c.name)).toEqual(["Choose", "Choose"]);
        const actor = CastActor.named("shadow").whoCan(new BrowseTheWeb(session, [origin]));
        expect(await act(actor, { op: "click", control: controls[1]! })).toEqual({ ok: true, mutated: true });
        expect(await session.page.evaluate(() => document.body.dataset.chosen)).toBe("pro");
        expect(await act(actor, { op: "click", control: controls[0]! })).toEqual({ ok: true, mutated: true });
        expect(await session.page.evaluate(() => document.body.dataset.chosen)).toBe("basic");
      },
      origin,
    );
  });

  it("a control in a CLOSED shadow root stays absent", async () => {
    await withSession(
      "shadow-closed-",
      async (session) => {
        await session.page.goto(`${origin}/closed`, { waitUntil: "domcontentloaded" });
        const names = (await snapshot(session.page)).controls.map((c) => c.name);
        expect(names).toEqual(["Light"]);
      },
      origin,
    );
  });

  it("perceive judges a page whose only control sits in an open shadow root as rendered", async () => {
    await withSession(
      "shadow-render-",
      async (session) => {
        await monitorFor(session.page).instrument();
        await session.page.goto(`${origin}/only-shadow`, { waitUntil: "domcontentloaded" });
        const p = await perceive(session.page, { emptySettleGraceMs: 0, renderWaitMs: 10_000 });
        expect(p.rendered).toBe(true);
        expect(p.snapshot.controls.map((c) => c.name)).toEqual(["Get started"]);
      },
      origin,
    );
  });

  it("a cover over the shadow button drops it from the snapshot AND the act() gate (one predicate)", async () => {
    await withSession(
      "shadow-covered-",
      async (session) => {
        await session.page.goto(`${origin}/open`, { waitUntil: "domcontentloaded" });
        const btn = (await snapshot(session.page)).controls.find((c) => c.name === "Get started");
        if (btn === undefined) throw new Error("Get started must be perceived while clickable");
        await session.page.goto(`${origin}/covered`, { waitUntil: "domcontentloaded" });
        const names = (await snapshot(session.page)).controls.map((c) => c.name);
        expect(names).toEqual(["Close"]);
        const actor = CastActor.named("shadow").whoCan(new BrowseTheWeb(session, [origin]));
        expect(await act(actor, { op: "click", control: btn })).toEqual({
          ok: false,
          mutated: false,
          reason: "target obscured by [data-testid=overlay]",
        });
      },
      origin,
    );
  });

  it("an overlay inside an open shadow root covers a light-DOM control, and is named from inside the root", async () => {
    await withSession(
      "shadow-cover-",
      async (session) => {
        await session.page.goto(`${origin}/shadow-cover`, { waitUntil: "domcontentloaded" });
        expect((await snapshot(session.page)).controls).toEqual([]);
        const cover = await session.page.locator("#under").evaluate(occluderOf);
        expect(cover).toBe("[data-testid=shadow-overlay]");
      },
      origin,
    );
  });
});
