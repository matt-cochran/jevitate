import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { PlaywrightBrowserPort, type BrowserSession } from "@jevitate/playwright";
import { clippingSummary, detectClipping } from "./overflow.js";
import { useSkippingTime } from "./testkit.js";

// #304: Node and page time skip idle waits (settle windows, hang ceilings, polls); assertions unchanged.
useSkippingTime({ per: "all" });

/**
 * #302 vertical clipping, REAL Chromium. `/issue` is the issue's own repro: a 56px header whose
 * centred `flex-wrap` chip wraps to four lines at 375px and spills above the page top. `/clipped`
 * is a fixed-height `overflow: hidden` card whose text is cut off. Every other page is intentional or
 * invisible and must stay silent: line-clamp, ellipsis, sr-only, a collapsed accordion, a skip link,
 * a scroll container, a scroll-locked body, and an --ignore-overflow match.
 */
const doc = (body: string, bodyStyle = "margin:0;font:16px/20px sans-serif"): string =>
  `<!doctype html><html><head><meta name="viewport" content="width=device-width"></head><body style="${bodyStyle}">${body}</body></html>`;
const LONG = "Your monthly report is ready. It covers usage, credits, invoices and every member who joined this month.";
const PAGES: Record<string, string> = {
  "/issue": doc(
    `<header style="height:56px;display:flex;align-items:center"><div data-testid="balance" style="display:flex;flex-wrap:wrap;width:120px;gap:0 4px"><span>1173.14</span><span>credits</span><span>balance</span><span>10.02</span><span>credits</span><span>held</span></div></header><main><p>Body</p></main>`,
  ),
  "/clipped": doc(`<div data-testid="card" style="height:40px;overflow:hidden;width:200px"><p style="margin:0">${LONG}</p></div>`),
  "/clamped": doc(`<p style="margin:0;width:200px;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden">${LONG}</p>`),
  "/ellipsis": doc(`<div style="height:20px;width:120px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis">${LONG}</div>`),
  "/quiet": doc(
    `<a href="#main" style="position:absolute;top:-40px;left:0">Skip to content</a>` +
      `<span style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap">Screen reader only text that is long</span>` +
      `<div style="height:0;overflow:hidden"><p>${LONG}</p></div>` +
      `<div style="height:40px;overflow:auto;width:200px"><p style="margin:0">${LONG}</p></div>` +
      `<div class="promo" style="height:40px;overflow:hidden;width:200px"><p style="margin:0">${LONG}</p></div>` +
      `<div style="height:40px;overflow:hidden;width:200px;visibility:hidden"><p style="margin:0">${LONG}</p></div>` +
      `<main id="main" style="height:3000px"><p>${LONG}</p></main>`,
    "margin:0;font:16px/20px sans-serif;overflow:hidden;height:100vh",
  ),
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
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
});

const port = new PlaywrightBrowserPort();
const sessions: BrowserSession[] = [];
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((s) => s.close()));
});

const VP = { width: 375, height: 812 };
async function openAt(path: string): Promise<BrowserSession> {
  const session = await port.open({ headless: true, allowedOrigins: [origin], baseUrl: origin, viewport: VP });
  sessions.push(session);
  await session.page.goto(`${origin}${path}`);
  return session;
}

describe("detectClipping (#302)", () => {
  test("the issue's repro: a wrapped chip spilling above the page top from a fixed-height header", async () => {
    const s = await openAt("/issue");
    const found = await detectClipping(s.page, { viewport: VP, device: "iPhone X" });
    expect(found).toHaveLength(1);
    const f = found[0]!;
    expect(f).toMatchObject({ kind: "vertical-clipping", cause: "above-page-top", route: "/issue", viewport: VP, device: "iPhone X" });
    expect(f.element.descriptor).toBe("[data-testid=balance]");
    expect(f.clippedPx).toBeGreaterThan(2);
    expect(f.fingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(clippingSummary(f)).toContain("above the top of the page");
  }, 60_000);

  test("a fixed-height overflow:hidden box cuts off its text — attributed to the box, deduped per element", async () => {
    const s = await openAt("/clipped");
    const found = await detectClipping(s.page, { viewport: VP });
    expect(found.map((f) => [f.cause, f.element.descriptor])).toEqual([["overflow-hidden", "[data-testid=card]"]]);
    expect(found[0]!.clippedPx).toBeGreaterThan(20);
    // Same element, same route: the same fingerprint on every check.
    const again = await detectClipping(s.page, { viewport: VP });
    expect(again[0]!.fingerprint).toBe(found[0]!.fingerprint);
    expect(await detectClipping(s.page, { viewport: VP, ignoreSelectors: ["[data-testid=card]"] })).toEqual([]);
  }, 60_000);

  test.each(["/clamped", "/ellipsis"])("intentional truncation (%s) is not reported", async (path) => {
    const s = await openAt(path);
    expect(await detectClipping(s.page, { viewport: VP })).toEqual([]);
  }, 60_000);

  test("sr-only, collapsed, skip-link, scrollable, hidden, scroll-locked-body and --ignore-overflow content stays silent", async () => {
    const s = await openAt("/quiet");
    expect(await detectClipping(s.page, { viewport: VP, ignoreSelectors: [".promo"] })).toEqual([]);
    // Without the ignore, the promo box is the one real clip on the page.
    expect((await detectClipping(s.page, { viewport: VP })).map((f) => f.element.descriptor)).toEqual(["div.promo"]);
  }, 60_000);
});
