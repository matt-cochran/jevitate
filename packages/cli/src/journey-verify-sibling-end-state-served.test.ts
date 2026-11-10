import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FsJourneyStore, type Journey } from "@jevitate/journey";
import { PlaywrightBrowserPort } from "@jevitate/playwright";
import { planJourneyVerification, verifyJourneyMutations, type JourneyVerifyPlanReport, type JourneyVerifyReport } from "./journey-verify.js";
import { useSkippingTime } from "../../explore/src/testkit.js";

useSkippingTime({ per: "all" });

/**
 * #817, through real Chromium: the owner-help shape. One Done click resolves the only request (its
 * step checks the POST's 2xx and the row's disappearance); three sibling end-state checks follow,
 * each declared to fail under skipping or blocking that write: the same POST, a reloadThen absence
 * check, and an HTTP read-back of `ownerHelpOpen`. After a reload the page shows its default view,
 * which never lists requests, so the absence check holds with or without the write: premature.
 * The proof keeps it a cascade (inconclusive overall), its targeted refusal says why — judged and
 * held, not blocked by its siblings — and `--plan` names the shape before any browser.
 */

let server: Server;
let origin: string;
let dir: string;
let open = 1;
let resolves = 0;

const page = (): string => `<!doctype html><html><head><title>Owner help</title></head><body><main>
  <h1>Owner help</h1>
  <p>Agency: Tidepool</p>
  <button type="button" id="today">Today</button>
  <ul id="list"></ul>
  <script>
    const open = ${open};
    document.getElementById("today").addEventListener("click", () => {
      const list = document.getElementById("list");
      list.textContent = "";
      for (let i = 0; i < open; i++) {
        const li = document.createElement("li");
        li.className = "request";
        li.textContent = "Help with invoices ";
        const done = document.createElement("button");
        done.type = "button";
        done.textContent = "Done";
        done.addEventListener("click", async () => {
          try {
            const r = await fetch("/api/resolve", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
            if (r.ok) li.remove();
          } catch { /* blocked: the row stays */ }
        });
        li.appendChild(done);
        list.appendChild(li);
      }
    });
  </script>
</main></body></html>`;

function ownerHelp(): Journey {
  return {
    metadata: {
      id: "owner-help",
      name: "Resolve an owner help request",
      promoted: false,
      params: [],
      createdAtIso: "2026-11-09T00:00:00.000Z",
      endState: [
        { kind: "responseStatus", method: "POST", pathGlob: "/api/resolve", status: { class: 2 } },
        { kind: "reloadThen", assertion: { kind: "count", target: { css: ".request" }, max: 0 } },
        { kind: "http", method: "GET", url: `${origin}/api/state`, textIncludes: ['"ownerHelpOpen":0'], withinMs: 2_000 },
      ],
      mutationPairs: [0, 1, 2].flatMap((i) => [
        { check: `end-state:${i}`, mustFailWhen: "skip:3" },
        { check: `end-state:${i}`, mustFailWhen: "block-write:3" },
      ]),
    },
    recording: {
      version: "1",
      site: origin,
      pages: [
        {
          url: "/start",
          steps: [
            { step: { kind: "navigate", url: "/start", expect: { kind: "visible", target: { role: "heading", name: "Owner help" } } } },
            { step: { kind: "click", target: { role: "button", name: "Today" }, expect: { kind: "visible", target: { css: ".request" } } } },
            {
              step: { kind: "click", target: { role: "button", name: "Done" }, expect: { kind: "count", target: { css: ".request" }, max: 0 } },
              expectRequests: [{ kind: "responseStatus", method: "POST", pathGlob: "/api/resolve", status: { class: 2 } }],
              delta: { verdict: "relevant-change", why: "resolved", changes: [], requests: ["POST /api/resolve → 200"], overheadMs: 1 },
            },
          ],
        },
      ],
    },
  } as unknown as Journey;
}

let plan: JourneyVerifyPlanReport;
let report: JourneyVerifyReport;

beforeAll(async () => {
  server = createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0];
    // Every replay starts at /start, which restores the one open request (the app's reset).
    if (req.method === "GET" && path === "/start") {
      open = 1;
      res.writeHead(302, { location: "/help" }).end();
    } else if (req.method === "GET" && path === "/help") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }).end(page());
    } else if (req.method === "POST" && path === "/api/resolve") {
      resolves++;
      open = 0;
      res.writeHead(200, { "content-type": "application/json" }).end("{}");
    } else if (req.method === "GET" && path === "/api/state") {
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify({ ownerHelpOpen: open }));
    } else {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  dir = await mkdtemp(join(tmpdir(), "jev-817-served-"));
  await new FsJourneyStore(dir).put(ownerHelp());
  plan = await planJourneyVerification({ dir, id: "owner-help", params: {} });
  report = await verifyJourneyMutations({ dir, id: "owner-help", params: {}, browserPortFactory: () => new PlaywrightBrowserPort() });
}, 300_000);

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(dir, { recursive: true, force: true });
});

const site = (key: string) => report.assertions.find((a) => a.site === key) as (JourneyVerifyReport["assertions"][number] & { targetedRefusal?: string }) | undefined;

describe("#817 sibling end-state checks on one write (served)", () => {
  it("--plan names the unsupported isolation shape before any browser", () => {
    expect(plan.isolationNotes).toEqual([{ site: "end-state:1", note: expect.stringContaining("end-state:1 checks an absence") as unknown as string }]);
    expect(plan.isolationNotes?.[0]?.note).toContain("shares block-write:3, skip:3 with sibling end-state checks end-state:0, end-state:2");
  });

  it("the base passes and the write ran in it (the passing unmutated control)", () => {
    expect(report.base.outcome, JSON.stringify(report.base)).toBe("ok");
    expect(resolves).toBeGreaterThan(0);
  });

  it("the POST and the HTTP read-back are sensitive to the write", () => {
    expect(site("end-state:0")?.verdict, JSON.stringify(report.assertions)).toBe("sensitive");
    expect(site("end-state:2")?.verdict).toBe("sensitive");
  });

  it("the premature reloadThen absence check stays a cascade, never sensitive, with a refusal that says why", () => {
    const premature = site("end-state:1");
    expect(premature?.verdict, JSON.stringify(report.assertions)).toBe("cascade");
    expect(premature?.targetedRefusal).toContain("end-state:1 was judged and held under");
    expect(premature?.targetedRefusal).toContain("end-state checks are judged independently");
    expect(premature?.targetedRefusal).toContain("as an absence check it also holds on a page or view that has not loaded");
  });

  it("the proof is inconclusive (exit 2), not sensitive", () => {
    expect(report.verdict).toBe("inconclusive");
  });
});
