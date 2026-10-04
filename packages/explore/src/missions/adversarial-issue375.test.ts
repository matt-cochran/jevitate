import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium } from "playwright";
import { FakeGenerationGateway, FakeJudgmentGateway } from "@jevitate/ai-core";
import { BrowseTheWeb, CastActor } from "@jevitate/screenplay";
import { runAdversarialMission, type AdversarialOutcome } from "./adversarial.js";
import { PageSignalCollector } from "../adversarial/defect-oracle.js";
import { useSkippingTime, withSession } from "../testkit.js";

/**
 * #375 — clicking an `sms:`/`tel:` link in headless Chromium (no handler for the scheme) is
 * reported as `requestfailed: net::ERR_ABORTED` for a navigation that never reached the network.
 * It was filed as an app defect (`failed-request: Request failed: /%2B15555550100`). A navigation
 * the browser hands to the OS is not a failed request of the system under test; a REAL failed
 * http(s) request on the same page still is.
 */

const PAGE = `<!doctype html><html><body>
  <h1>Contact</h1>
  <a href="sms:+15555550100?body=Hello">Text us</a>
  <a href="tel:+15555550100">Call</a>
  <button id="load" type="button">Load offers</button>
  <div id="out" role="status"></div>
  <script>
    document.getElementById("load").addEventListener("click", async () => {
      try { await fetch("/api/offers"); } catch { document.getElementById("out").textContent = "Could not load offers"; }
    });
  </script>
</body></html>`;

let server: Server;
let origin: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0] ?? "";
    if (path === "/api/offers") {
      // A genuine network-level failure: the connection is dropped with no response at all.
      req.socket.destroy();
      return;
    }
    if (path === "/contact") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(PAGE);
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (addr === null || typeof addr === "string") throw new Error("server has no port");
  origin = `http://127.0.0.1:${(addr satisfies AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("PageSignalCollector — external-scheme links (#375)", () => {
  it("an sms:/tel: click is not a failed-request signal; a dropped http request still is", async () => {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      const raw: string[] = [];
      page.on("requestfailed", (r) => raw.push(`${r.url()} ${r.failure()?.errorText ?? ""}`));
      const collector = new PageSignalCollector(page);
      await page.goto(`${origin}/contact`);
      for (const name of ["Text us", "Call"]) {
        const failed = page.waitForEvent("requestfailed");
        await page.getByRole("link", { name }).click();
        await failed;
      }
      // The repro genuinely exercises Chromium's abort of both external-scheme navigations.
      expect(raw).toEqual(["sms:+15555550100?body=Hello net::ERR_ABORTED", "tel:+15555550100 net::ERR_ABORTED"]);
      expect(collector.drain().filter((s) => s.kind === "failed-request")).toEqual([]);

      const broken = page.waitForEvent("requestfailed");
      await page.getByRole("button", { name: "Load offers" }).click();
      await broken;
      const failedRequests = collector.drain().filter((s) => s.kind === "failed-request");
      expect(failedRequests.map((s) => s.kind === "failed-request" && s.url)).toEqual([`${origin}/api/offers`]);
    } finally {
      await browser.close();
    }
  }, 60_000);
});

async function hunt(): Promise<AdversarialOutcome> {
  return withSession(
    "adv-375-",
    async (session) => {
      const actor = CastActor.named("adversary").whoCan(new BrowseTheWeb(session, [origin]));
      return runAdversarialMission({
        page: session.page,
        actor,
        judgment: new FakeJudgmentGateway({ looksBroken: { kind: "noul", value: false, probability: 0.1 } }),
        generation: new FakeGenerationGateway(),
        seedUrl: `${origin}/contact`,
        allowlist: [origin],
        strategies: ["exercise-controls"],
        bounds: { maxActions: 12 },
      });
    },
    origin,
  );
}

describe("adversarial — sms:/tel: links beside a real broken request (#375)", () => {
  useSkippingTime();
  it(
    "clicks the sms:/tel: links without filing a defect for them; the dropped http request is still a defect",
    async () => {
      const result = await hunt();
      expect(result.outcome).not.toBe("crashed");
      const t = result.transcript;
      // The run actually clicked both external-scheme links (the assertion below is not vacuous).
      expect(t.some((e) => e.op === "click" && e.target?.includes("Text us") === true && e.actOk)).toBe(true);
      expect(t.some((e) => e.op === "click" && e.target?.includes("Call") === true && e.actOk)).toBe(true);
      const failedRequests = result.defects.filter((d) => d.signals.some((s) => s.kind === "failed-request"));
      const urls = failedRequests.flatMap((d) => d.signals.flatMap((s) => (s.kind === "failed-request" ? [s.url] : [])));
      expect(urls.some((u) => /sms:|tel:|%2B1555/i.test(u))).toBe(false);
      expect(urls).toContain(`${origin}/api/offers`);
    },
    300_000,
  );
});
