import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { chromium, type Browser } from "playwright";
import { FakeGenerationGateway, FakeJudgmentGateway } from "@jevitate/ai-core";
import { BrowseTheWeb, CastActor } from "@jevitate/screenplay";
import { runAdversarialMission } from "./adversarial.js";
import { isAdvisoryConsoleError, PageSignalCollector, type DefectSignal } from "../adversarial/defect-oracle.js";
import { signalFingerprint } from "../adversarial/defect-fingerprint.js";
import { withSession } from "../testkit.js";

/**
 * #297 on served pages (real Chromium, site isolation on). The app (127.0.0.1:<app>, no CSP) embeds
 * a vendor iframe from another site (`localhost:<tp>`, NOT in `--allow`). The vendor's document is
 * served with a strict `style-src` CSP and sets an inline style, so Chromium logs "Applying inline
 * style violates the following Content Security Policy directive …" — in the VENDOR's frame; the
 * vendor's own script also calls `console.error`. Before the fix each one was reported as a
 * `console-error` defect of the app page, fingerprinted per route, with no frame URL. Now every
 * console signal carries its frame URL, and one from a third-party frame is advisory (one identity
 * per vendor + message, whichever route embeds it). The app's own console.error stays a defect.
 */

let app: Server;
let tp: Server;
let origin: string;
let tpOrigin: string;

const vendorFrame = (): string => `<!doctype html><html><body><p id="x">card field</p>
<script src="/sdk.js"></script>
<script>document.getElementById("x").setAttribute("style", "color: red");</script>
</body></html>`;

const appPage = (route: string): string => `<!doctype html><html><body>
<h1>Checkout ${route}</h1>
<form><label>Name <input name="name" aria-label="Name" /></label><button type="submit">Save</button></form>
<iframe title="payment" src="${tpOrigin}/frame.html"></iframe>
<script>setTimeout(() => console.error("app own failure: totals did not load"), 50);</script>
</body></html>`;

beforeAll(async () => {
  tp = createServer((req, res) => {
    if (req.url === "/sdk.js") {
      res.writeHead(200, { "content-type": "text/javascript" }).end('console.error("vendor sdk: telemetry blocked");');
      return;
    }
    res
      .writeHead(200, { "content-type": "text/html; charset=utf-8", "content-security-policy": `style-src ${tpOrigin}` })
      .end(vendorFrame());
  });
  await new Promise<void>((resolve) => tp.listen(0, "127.0.0.1", resolve));
  tpOrigin = `http://localhost:${(tp.address() as AddressInfo).port}`;
  app = createServer((req, res) => {
    if (req.method === "POST") {
      res.writeHead(200, { "content-type": "application/json" }).end("{}");
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(appPage(req.url ?? "/"));
  });
  await new Promise<void>((resolve) => app.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
});
afterAll(async () => {
  app.closeAllConnections();
  tp.closeAllConnections();
  await new Promise<void>((resolve) => app.close(() => resolve()));
  await new Promise<void>((resolve) => tp.close(() => resolve()));
});

type ConsoleSignal = Extract<DefectSignal, { kind: "console-error" }>;

async function consoleSignals(route: string): Promise<ConsoleSignal[]> {
  const browser: Browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const collector = new PageSignalCollector(page, Date.now, [origin]);
    await page.goto(`${origin}${route}`);
    await page.waitForTimeout(1_000);
    return collector.drain().filter((s): s is ConsoleSignal => s.kind === "console-error");
  } finally {
    await browser.close();
  }
}

describe("console errors from a cross-origin third-party iframe (#297)", () => {
  test("each signal carries its frame URL; the vendor frame's errors are third-party advisories, the app's own is not", async () => {
    const a = await consoleSignals("/checkout");
    const csp = a.find((s) => /Content Security Policy/.test(s.detail));
    const sdk = a.find((s) => /vendor sdk/.test(s.detail));
    const own = a.find((s) => /app own failure/.test(s.detail));
    // The browser-generated CSP violation (its source is the frame's document).
    expect(csp).toMatchObject({ frameUrl: `${tpOrigin}/frame.html`, thirdPartyFrame: tpOrigin });
    // The vendor script's own console.error (its source is a script the vendor frame loaded).
    expect(sdk).toMatchObject({ frameUrl: `${tpOrigin}/frame.html`, thirdPartyFrame: tpOrigin });
    expect(own).toMatchObject({ frameUrl: `${origin}/checkout` });
    expect(own?.thirdPartyFrame).toBeUndefined();
    expect(isAdvisoryConsoleError(csp as ConsoleSignal)).toBe(true);
    expect(isAdvisoryConsoleError(sdk as ConsoleSignal)).toBe(true);
    expect(isAdvisoryConsoleError(own as ConsoleSignal)).toBe(false);
    // The vendor's noise has ONE identity whichever app route embeds it; the app's own is per route.
    const b = await consoleSignals("/billing");
    const cspB = b.find((s) => /Content Security Policy/.test(s.detail)) as ConsoleSignal;
    const ownB = b.find((s) => /app own failure/.test(s.detail)) as ConsoleSignal;
    expect(signalFingerprint(cspB)).toBe(signalFingerprint(csp as ConsoleSignal));
    expect(signalFingerprint(ownB)).not.toBe(signalFingerprint(own as ConsoleSignal));
  }, 60_000);

  test("an adversarial run files the app's own console error as a defect, and the vendor frame's as advisories only", async () => {
    const result = await withSession(
      "third-party-frame-",
      async (session) => {
        const actor = CastActor.named("adversary").whoCan(new BrowseTheWeb(session, [origin]));
        return runAdversarialMission({
          page: session.page,
          actor,
          judgment: new FakeJudgmentGateway({ looksBroken: { kind: "noul", value: false, probability: 0.1 } }),
          generation: new FakeGenerationGateway(),
          seedUrl: `${origin}/checkout`,
          allowlist: [origin],
          bounds: { maxDecisions: 2 },
          strategies: ["exercise-controls"],
        });
      },
      origin,
    );
    const consoleDefectSignals = result.defects.flatMap((d) => d.signals).filter((s): s is ConsoleSignal => s.kind === "console-error");
    expect(consoleDefectSignals.some((s) => /app own failure/.test(s.detail))).toBe(true);
    expect(consoleDefectSignals.some((s) => s.thirdPartyFrame !== undefined || /Content Security Policy|vendor sdk/.test(s.detail))).toBe(false);
    const vendor = result.advisories.filter((a) => a.thirdPartyFrame === tpOrigin);
    expect(vendor.length).toBeGreaterThanOrEqual(1);
    expect(vendor[0]).toMatchObject({ kind: "console-error", frameUrl: `${tpOrigin}/frame.html` });
    expect(vendor[0]?.status).toBeUndefined();
    expect(vendor[0]?.title).toContain(`third-party frame from ${tpOrigin}`);
  }, 120_000);
});
