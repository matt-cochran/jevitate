import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeGenerationGateway } from "@jevitate/ai-core";
import { BrowseTheWeb, CastActor } from "@jevitate/screenplay";
import { act, explore, perceive, snapshot } from "./index.js";
import { ScriptedJudge, withSession } from "./testkit.js";

/**
 * The shared perception step (render wait + occlusion) and the act() hardening (occlusion gate,
 * automation errors as failed acts) — proved against a served page, as a real browser sees it.
 */

const PAGES: Record<string, string> = {
  "/blank": `<!doctype html><html><body><h1>Nothing to do here</h1><p>Just text.</p></body></html>`,
  "/late": `<!doctype html><html><body><div id="root"></div><script>
    setTimeout(() => { const b = document.createElement("button"); b.textContent = "Rendered late"; document.getElementById("root").appendChild(b); }, 600);
  </script></body></html>`,
  "/overlay": `<!doctype html><html><body>
    <button type="button" id="behind" onclick="this.textContent='clicked'">Behind</button>
    <div data-testid="overlay" style="position:fixed;inset:0;background:rgba(0,0,0,.4)">
      <button type="button">Close</button>
    </div>
  </body></html>`,
  "/number": `<!doctype html><html><body><label>Qty <input type="number" aria-label="Qty" /></label></body></html>`,
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
  await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
});

describe("perceive — bounded render wait", () => {
  it("waits for a late-rendering SPA frame instead of perceiving zero controls", async () => {
    await withSession(
      "perceive-late-",
      async (session) => {
        await session.page.goto(`${origin}/late`, { waitUntil: "domcontentloaded" });
        const p = await perceive(session.page, { renderWaitMs: 10_000, pollMs: 100 });
        expect(p.rendered).toBe(true);
        expect(p.snapshot.controls.map((c) => c.name)).toEqual(["Rendered late"]);
      },
      origin,
    );
  });

  it("fails closed — rendered:false with a reason — when nothing renders within the bound", async () => {
    await withSession(
      "perceive-blank-",
      async (session) => {
        await session.page.goto(`${origin}/blank`, { waitUntil: "domcontentloaded" });
        const started = Date.now();
        const p = await perceive(session.page, { renderWaitMs: 400, pollMs: 100 });
        expect(Date.now() - started).toBeLessThan(5_000);
        expect(p.rendered).toBe(false);
        if (!p.rendered) expect(p.reason).toBe("page rendered no interactive controls within 400ms");
        expect(p.snapshot.controls).toEqual([]);
      },
      origin,
    );
  });

  it("rejects a nonsensical bound rather than looping", async () => {
    await withSession(
      "perceive-bad-",
      async (session) => {
        await expect(perceive(session.page, { renderWaitMs: -1 })).rejects.toThrow(/renderWaitMs/);
        await expect(perceive(session.page, { pollMs: 0 })).rejects.toThrow(/pollMs/);
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
          renderWaitMs: 300,
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
      reason: "page rendered no interactive controls within 300ms (fail-closed)",
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
