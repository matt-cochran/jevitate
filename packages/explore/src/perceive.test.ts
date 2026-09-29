import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeGenerationGateway } from "@jevitate/ai-core";
import { BrowseTheWeb, CastActor } from "@jevitate/screenplay";
import { act, explore, monitorFor, occluderOf, perceive, snapshot } from "./index.js";
import { ScriptedJudge, withSession } from "./testkit.js";

/**
 * The shared perception step (render wait + occlusion) and the act() hardening (occlusion gate,
 * automation errors as failed acts) — proved against a served page, as a real browser sees it.
 */

const PAGES: Record<string, string> = {
  "/blank": `<!doctype html><html><body><h1>Nothing to do here</h1><p>Just text.</p></body></html>`,
  // A real SPA frame: the shell loads, fetches its data (slow), then renders the control.
  "/late": `<!doctype html><html><body><div id="root"></div><script>
    fetch("/slow-data").then(() => { const b = document.createElement("button"); b.textContent = "Rendered late"; document.getElementById("root").appendChild(b); });
  </script></body></html>`,
  "/overlay": `<!doctype html><html><body>
    <button type="button" id="behind" onclick="this.textContent='clicked'">Behind</button>
    <div data-testid="overlay" style="position:fixed;inset:0;background:rgba(0,0,0,.4)">
      <button type="button">Close</button>
    </div>
  </body></html>`,
  "/number": `<!doctype html><html><body><label>Qty <input type="number" aria-label="Qty" /></label></body></html>`,
  // The covering element is the control's own ANCESTOR (the button lets clicks fall through).
  "/ancestor": `<!doctype html><html><body>
    <div data-testid="wrap" style="padding:24px;background:#eee">
      <button type="button" id="ghost" onclick="this.textContent='clicked'">Ghost</button>
    </div>
    <button type="button">Other</button>
  </body></html>`,
  // The topmost element is the control's own DESCENDANT (its label span): never a cover.
  "/descendant": `<!doctype html><html><body>
    <button type="button" id="labelled" onclick="this.dataset.clicked='yes'"><span style="padding:8px">Inner label</span></button>
  </body></html>`,
  "/pending": `<!doctype html><html><body><p>Loading…</p><script>fetch("/never").catch(() => undefined);</script></body></html>`,
  "/churn": `<!doctype html><html><body><button type="button">Go</button><ul></ul><script>
    let n = 0; const t = setInterval(() => { const li = document.createElement("li"); li.textContent = String(n); document.querySelector("ul").appendChild(li); if (++n === 12) clearInterval(t); }, 100);
  </script></body></html>`,
};

let server: Server;
let origin: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === "/never") return; // never responds
    if (req.url === "/slow-data") {
      setTimeout(() => res.writeHead(200, { "content-type": "application/json" }).end("{}"), 800);
      return;
    }
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

describe("perceive — bounded render wait", () => {
  it("waits for a late-rendering SPA frame instead of perceiving zero controls", async () => {
    await withSession(
      "perceive-late-",
      async (session) => {
        await monitorFor(session.page).instrument();
        await session.page.goto(`${origin}/late`, { waitUntil: "domcontentloaded" });
        const p = await perceive(session.page, { renderWaitMs: 10_000 });
        expect(p.rendered).toBe(true);
        expect(p.snapshot.controls.map((c) => c.name)).toEqual(["Rendered late"]);
      },
      origin,
    );
  });

  it("judges a control-free page BLANK by the settled signal — in about the quiet window, not the ceiling", async () => {
    await withSession(
      "perceive-blank-",
      async (session) => {
        await monitorFor(session.page).instrument();
        await session.page.goto(`${origin}/blank`, { waitUntil: "domcontentloaded" });
        const started = Date.now();
        // The full 15s ceiling is in force: a time guess would take 15s; the settle rule does not.
        const p = await perceive(session.page);
        expect(Date.now() - started).toBeLessThan(5_000);
        expect(p.rendered).toBe(false);
        if (!p.rendered) expect(p.reason).toBe("page settled with no interactive controls");
        expect(p.settle.settled).toBe(true);
        expect(p.snapshot.controls).toEqual([]);
      },
      origin,
    );
  });

  it("fails closed at the ceiling when a control-free page never settles (a request stays pending)", async () => {
    await withSession(
      "perceive-pending-",
      async (session) => {
        await monitorFor(session.page).instrument();
        await session.page.goto(`${origin}/pending`, { waitUntil: "domcontentloaded" });
        const p = await perceive(session.page, { renderWaitMs: 1_500 });
        expect(p.rendered).toBe(false);
        if (!p.rendered) expect(p.reason).toBe("page rendered no interactive controls within 1500ms");
        expect(p.settle.settled).toBe(false);
        expect(p.settle.pending.map((r) => new URL(r.url).pathname)).toEqual(["/never"]);
      },
      origin,
    );
  });

  it("waits for DOM mutations to stop before reading the page (the settle rule's quiet window)", async () => {
    await withSession(
      "perceive-busy-dom-",
      async (session) => {
        await monitorFor(session.page).instrument();
        await session.page.goto(`${origin}/churn`, { waitUntil: "domcontentloaded" });
        const p = await perceive(session.page);
        expect(p.rendered).toBe(true);
        // The page appends a row every 100ms for ~1.2s; the snapshot is taken after the churn.
        expect(p.settle.settled).toBe(true);
        expect(p.settle.waitedMs).toBeGreaterThanOrEqual(1_000);
        expect(await session.page.locator("li").count()).toBe(12);
      },
      origin,
    );
  });

  it("rejects a nonsensical bound rather than looping", async () => {
    await withSession(
      "perceive-bad-",
      async (session) => {
        await expect(perceive(session.page, { renderWaitMs: -1 })).rejects.toThrow(/renderWaitMs/);
        await expect(perceive(session.page, { quietMs: -5 })).rejects.toThrow(/quietMs/);
      },
      origin,
    );
  });
});

describe("explore — never decides on an unrendered page", () => {
  it("stops blocked without asking the model, recording why in the transcript", async () => {
    const judge = new ScriptedJudge([{ op: "done" }]);
    const run = await withSession(
      "perceive-explore-blank-",
      async (session) => {
        const actor = CastActor.named("render").whoCan(new BrowseTheWeb(session, [origin]));
        return explore({
          actor,
          judge,
          gen: new FakeGenerationGateway(),
          goal: "do something",
          allowlist: [origin],
          startUrl: `${origin}/blank`,
        });
      },
      origin,
    );
    expect(run.stop).toBe("blocked");
    expect(run.decisions).toBe(0);
    expect(judge.calls).toHaveLength(0);
    expect(run.transcript).toHaveLength(1);
    expect(run.transcript[0]).toMatchObject({
      step: 1,
      op: "wait",
      target: null,
      confidence: null,
      chosenBy: "strategy",
      actOk: false,
      controlCount: 0,
      reason: "page settled with no interactive controls (fail-closed)",
    });
  });
});

describe("occlusion — a covered control is neither perceived nor acted on", () => {
  it("snapshot omits controls behind a fixed overlay but offers the overlay's own controls", async () => {
    await withSession(
      "perceive-occluded-snap-",
      async (session) => {
        await session.page.goto(`${origin}/overlay`, { waitUntil: "domcontentloaded" });
        const names = (await snapshot(session.page)).controls.map((c) => c.name);
        expect(names).toContain("Close");
        expect(names).not.toContain("Behind");
      },
      origin,
    );
  });

  it("act() refuses a stale target that became covered, naming the cover — and does not click it", async () => {
    await withSession(
      "perceive-occluded-act-",
      async (session) => {
        await session.page.goto(`${origin}/overlay`, { waitUntil: "domcontentloaded" });
        // Perceive BEFORE the overlay is up (hide it), then raise it: the decision is now stale.
        await session.page.evaluate(() => {
          const o = document.querySelector<HTMLElement>("[data-testid=overlay]");
          if (o !== null) o.style.display = "none";
        });
        const behind = (await snapshot(session.page)).controls.find((c) => c.name === "Behind");
        if (behind === undefined) throw new Error("Behind not perceived while uncovered");
        await session.page.evaluate(() => {
          const o = document.querySelector<HTMLElement>("[data-testid=overlay]");
          if (o !== null) o.style.display = "block";
        });

        const actor = CastActor.named("occlusion").whoCan(new BrowseTheWeb(session, [origin]));
        const started = Date.now();
        const r = await act(actor, { op: "click", control: behind });
        expect(r).toEqual({ ok: false, mutated: false, reason: "target obscured by [data-testid=overlay]" });
        // Refused up front — not after waiting out Playwright's actionability timeout.
        expect(Date.now() - started).toBeLessThan(5_000);
        expect(await session.page.locator("#behind").textContent()).toBe("Behind");
      },
      origin,
    );
  });
});

describe("occlusion — ONE shared predicate for the snapshot filter and the act() gate (owner ruling 5)", () => {
  it("an ANCESTOR on top covers the control: the snapshot drops it AND act() refuses it, naming the ancestor", async () => {
    await withSession(
      "occlusion-ancestor-",
      async (session) => {
        await session.page.goto(`${origin}/ancestor`, { waitUntil: "domcontentloaded" });
        const ghost = (await snapshot(session.page)).controls.find((c) => c.name === "Ghost");
        if (ghost === undefined) throw new Error("Ghost not perceived while clickable");
        // Now clicks at the button's centre fall through to its wrapper (its ancestor).
        await session.page.evaluate(() => {
          const b = document.getElementById("ghost");
          if (b !== null) b.style.pointerEvents = "none";
        });
        const names = (await snapshot(session.page)).controls.map((c) => c.name);
        expect(names).not.toContain("Ghost");
        expect(names).toContain("Other");

        const actor = CastActor.named("occlusion").whoCan(new BrowseTheWeb(session, [origin]));
        const r = await act(actor, { op: "click", control: ghost });
        expect(r).toEqual({ ok: false, mutated: false, reason: "target obscured by [data-testid=wrap]" });
        expect(await session.page.locator("#ghost").textContent()).toBe("Ghost");
      },
      origin,
    );
  });

  it("a DESCENDANT on top is the control's own content: perceived AND clickable", async () => {
    await withSession(
      "occlusion-descendant-",
      async (session) => {
        await session.page.goto(`${origin}/descendant`, { waitUntil: "domcontentloaded" });
        const btn = (await snapshot(session.page)).controls.find((c) => c.name === "Inner label");
        if (btn === undefined) throw new Error("the button with a label span must be perceived");
        const actor = CastActor.named("occlusion").whoCan(new BrowseTheWeb(session, [origin]));
        expect(await act(actor, { op: "click", control: btn })).toEqual({ ok: true, mutated: true });
        expect(await session.page.locator("#labelled").getAttribute("data-clicked")).toBe("yes");
      },
      origin,
    );
  });

  it("the snapshot and the gate agree on every control of every fixture (one predicate, one answer)", async () => {
    await withSession(
      "occlusion-agree-",
      async (session) => {
        const actor = CastActor.named("occlusion").whoCan(new BrowseTheWeb(session, [origin]));
        for (const path of ["/overlay", "/ancestor", "/descendant"]) {
          await session.page.goto(`${origin}${path}`, { waitUntil: "domcontentloaded" });
          await session.page.evaluate(() => {
            const b = document.getElementById("ghost");
            if (b !== null) b.style.pointerEvents = "none";
          });
          const offered = new Set((await snapshot(session.page)).controls.map((c) => c.name));
          for (const handle of await session.page.locator("button").elementHandles()) {
            const name = (await handle.textContent())?.trim() ?? "";
            const covered = (await handle.evaluate(occluderOf)) !== null;
            expect(offered.has(name), `${path} ${name}: snapshot vs predicate`).toBe(!covered);
            await handle.dispose();
          }
        }
        // And the gate says the same as the snapshot for a control it did offer.
        await session.page.goto(`${origin}/overlay`, { waitUntil: "domcontentloaded" });
        const close = (await snapshot(session.page)).controls.find((c) => c.name === "Close");
        if (close === undefined) throw new Error("Close must be offered");
        expect((await act(actor, { op: "click", control: close })).ok).toBe(true);
      },
      origin,
    );
  });
});

describe("act — an automation error is a failed act, never a run-killing exception", () => {
  it("typing text Playwright cannot enter returns ok:false with the error's first line", async () => {
    await withSession(
      "perceive-attempt-",
      async (session) => {
        await session.page.goto(`${origin}/number`, { waitUntil: "domcontentloaded" });
        const qty = (await snapshot(session.page)).controls.find((c) => c.name === "Qty");
        if (qty === undefined) throw new Error("Qty not perceived");
        const actor = CastActor.named("attempt").whoCan(new BrowseTheWeb(session, [origin]));
        const r = await act(actor, { op: "type", control: qty, value: "not a number" });
        expect(r.ok).toBe(false);
        expect(r.mutated).toBe(false);
        expect(r.reason).toMatch(/^action failed: /);
        expect(r.reason).not.toContain("\n");
      },
      origin,
    );
  });
});
