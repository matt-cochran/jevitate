import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { PlaywrightBrowserPort, type BrowserSession } from "@jevitate/playwright";
import { detectOverflow, shouldCheckOverflow, DEFAULT_OVERFLOW_VIEWPORT_THRESHOLD } from "./overflow.js";

/**
 * `/wide`: a table[data-testid=wide] with min-width:600px and no scroll wrapper — page-level
 * overflow at a narrow viewport (mirrors `apps/example-site`'s `/responsive/overflow`).
 * `/contained`: the SAME table inside an overflow-x:auto wrapper — never page-level.
 * `/ok`: fluid — never overflows.
 */
const WIDE_TABLE = `<table data-testid="wide" style="min-width:600px"><tbody><tr><td>k_live_1</td><td>Production key</td></tr></tbody></table>`;
const PAGES: Record<string, string> = {
  "/wide": `<!doctype html><html><body style="margin:0;padding:0"><h1>Overflow</h1>${WIDE_TABLE}</body></html>`,
  "/contained": `<!doctype html><html><body style="margin:0;padding:0"><h1>Contained</h1><div style="overflow-x:auto;max-width:100%">${WIDE_TABLE}</div></body></html>`,
  "/ok": `<!doctype html><html><body style="margin:0;padding:0"><h1>OK</h1><table style="max-width:100%;width:100%"><tbody><tr><td>k_live_1</td></tr></tbody></table></body></html>`,
  "/aria": `<!doctype html><html><body style="margin:0;padding:0"><h1>Overflow with long aria-label</h1><table data-testid="wide" aria-label="${"x".repeat(900)}s3cr3t" style="min-width:600px"><tbody><tr><td>k</td></tr></tbody></table></body></html>`,
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

async function openAt(path: string, viewport: { width: number; height: number }): Promise<BrowserSession> {
  const session = await port.open({ headless: true, allowedOrigins: [origin], baseUrl: origin, viewport });
  sessions.push(session);
  await session.page.goto(`${origin}${path}`);
  return session;
}

describe("detectOverflow", () => {
  test("attributes page-level overflow to the widest offending element, with overflowPx and route", async () => {
    const session = await openAt("/wide", { width: 375, height: 812 });
    const finding = await detectOverflow(session.page, { viewport: { width: 375, height: 812 } });
    expect(finding).not.toBeNull();
    expect(finding?.kind).toBe("horizontal-overflow");
    expect(finding?.element.descriptor).toBe("[data-testid=wide]");
    expect(finding?.overflowPx).toBeGreaterThanOrEqual(200);
    expect(finding?.overflowPx).toBeLessThanOrEqual(250);
    expect(finding?.route).toBe("/wide");
  }, 30_000);

  test("no finding at a 1280px viewport (the same page fits)", async () => {
    const session = await openAt("/wide", { width: 1280, height: 800 });
    const finding = await detectOverflow(session.page, { viewport: { width: 1280, height: 800 } });
    expect(finding).toBeNull();
  }, 30_000);

  test("no finding when the wide table is inside an overflow-x:auto wrapper (contained, not page-level)", async () => {
    const session = await openAt("/contained", { width: 375, height: 812 });
    const finding = await detectOverflow(session.page, { viewport: { width: 375, height: 812 } });
    expect(finding).toBeNull();
  }, 30_000);

  test("no finding on a fluid page", async () => {
    const session = await openAt("/ok", { width: 375, height: 812 });
    const finding = await detectOverflow(session.page, { viewport: { width: 375, height: 812 } });
    expect(finding).toBeNull();
  }, 30_000);

  test("--ignore-overflow suppresses a matching element", async () => {
    const session = await openAt("/wide", { width: 375, height: 812 });
    const finding = await detectOverflow(session.page, {
      viewport: { width: 375, height: 812 },
      ignoreSelectors: ["[data-testid=wide]"],
    });
    expect(finding).toBeNull();
  }, 30_000);

  test("a long aria-label descriptor is clipped and redacted, never leaked in full (#149/A12)", async () => {
    const session = await openAt("/aria", { width: 375, height: 812 });
    const finding = await detectOverflow(session.page, { viewport: { width: 375, height: 812 }, secrets: ["s3cr3t"] });
    expect(finding).not.toBeNull();
    expect(finding!.element.descriptor.length).toBeLessThan(200);
    expect(finding!.element.descriptor).not.toContain("s3cr3t");
  }, 30_000);

  test("device emulation is carried onto the finding", async () => {
    const session = await openAt("/wide", { width: 390, height: 664 });
    const finding = await detectOverflow(session.page, { viewport: { width: 390, height: 664 }, device: "iPhone 13" });
    expect(finding?.device).toBe("iPhone 13");
  }, 30_000);
});

describe("shouldCheckOverflow", () => {
  test("runs by default under the threshold", () => {
    expect(shouldCheckOverflow(375, false)).toBe(true);
    expect(shouldCheckOverflow(DEFAULT_OVERFLOW_VIEWPORT_THRESHOLD - 1, false)).toBe(true);
  });
  test("does not run at/above the threshold unless opted in", () => {
    expect(shouldCheckOverflow(DEFAULT_OVERFLOW_VIEWPORT_THRESHOLD, false)).toBe(false);
    expect(shouldCheckOverflow(1280, false)).toBe(false);
    expect(shouldCheckOverflow(1280, true)).toBe(true);
  });
  test("with no emulated viewport, runs only when opted in", () => {
    expect(shouldCheckOverflow(undefined, false)).toBe(false);
    expect(shouldCheckOverflow(undefined, true)).toBe(true);
  });
});
