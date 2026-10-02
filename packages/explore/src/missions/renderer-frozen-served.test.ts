import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeGenerationGateway, FakeJudgmentGateway } from "@jevitate/ai-core";
import { PlaywrightBrowserPort } from "@jevitate/playwright";
import { BrowseTheWeb, CastActor } from "@jevitate/screenplay";
import { runAdversarialMission } from "./adversarial.js";
import { useSkippingTime } from "../testkit.js";

// #304: Node and page time skip idle waits (settle windows, hang ceilings, polls); assertions unchanged.
useSkippingTime({ per: "all" });

/**
 * #296: the page's renderer stops answering in the MIDDLE of a perception (a Storybook story that
 * wedges its main thread after a reload, while jevitate reads its controls). The liveness watchdog
 * closes the page so the run ends; the closed page then rejects jevitate's pending read
 * (`locator.elementHandles: Target page, context or browser has been closed`). That rejection has a
 * jevitate stack frame, but nothing in jevitate failed: the run must end TYPED — `inconclusive`,
 * `failure.kind: "stalled"` naming the frozen renderer — never `crashed` with an issue attributed to
 * jevitate itself.
 */

const html = (body: string): string => `<!doctype html><html><body>${body}</body></html>`;
let server: Server;
let origin: string;

/**
 * A search form. Once the page has been reloaded with an unsaved edit, the story wedges.
 */
const story = html(`<main><form id="f"><input type="search" name="q" aria-label="Search phone numbers"><button type="submit">Search</button></form>
  <p id="out"></p></main><script>
  document.getElementById("f").onsubmit = (e) => { e.preventDefault(); document.getElementById("out").textContent = "No results"; };
  addEventListener("beforeunload", () => sessionStorage.setItem("reloaded", "1"));
  if (sessionStorage.getItem("reloaded") === "1") {
    // It renders for a second, then its main thread spins forever — after jevitate's perception of
    // the reloaded page has started (its responsiveness probe answered), before it could finish.
    let n = 0;
    const tick = setInterval(() => {
      document.body.appendChild(document.createElement("i"));
      if (++n >= 10) { clearInterval(tick); setTimeout(() => { for (;;) {} }, 300); }
    }, 100);
  }
</script>`);

beforeAll(async () => {
  server = createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0] ?? "";
    if (path === "/iframe.html") return void res.writeHead(200, { "content-type": "text/html" }).end(story);
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("#296 — a renderer that freezes mid-perception ends typed, never a jevitate crash", () => {
  it("ends inconclusive with failure.kind stalled naming the frozen page, and no crash report", async () => {
    const port = new PlaywrightBrowserPort({ liveness: { unresponsiveMs: 6_000 } });
    const session = await port.open({ headless: true, allowedOrigins: [origin], baseUrl: origin });
    try {
      const actor = CastActor.named("frozen-renderer").whoCan(new BrowseTheWeb(session, [origin]));
      const result = await runAdversarialMission({
        page: session.page,
        actor,
        judgment: new FakeJudgmentGateway({ looksBroken: { kind: "noul", value: false, probability: 0 } }),
        generation: new FakeGenerationGateway(),
        seedUrl: `${origin}/iframe.html?id=phone--error-state&viewMode=story`,
        allowlist: [origin],
        strategies: ["double-submit", "boundary-submit", "navigate-away-unsaved"],
        bounds: { maxDecisions: 12 },
        renderWaitMs: 4_000,
        requestBoundMs: 3_000,
        hangProbeMs: 2_000,
      });
      expect(result.failure?.kind).toBe("stalled");
      expect(result.failure?.message).toMatch(/page process stopped responding/);
      expect(result.outcome).toBe("inconclusive");
      expect(result.stop).toBe("stalled");
      expect(result.failure?.stack).toBeUndefined(); // nothing in jevitate failed: no frame to attribute
      expect(result.crash).toBeUndefined();
    } finally {
      await session.close().catch(() => undefined);
    }
  }, 180_000);
});
