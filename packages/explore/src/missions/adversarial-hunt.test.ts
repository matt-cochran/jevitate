import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeGenerationGateway, FakeJudgmentGateway } from "@jevitate/ai-core";
import { PlaywrightBrowserPort } from "@jevitate/playwright";
import { BrowseTheWeb, CastActor } from "@jevitate/screenplay";
import { runAdversarialMission, type AdversarialOutcome } from "./adversarial.js";
import { verifyFix, type VerifySession } from "../verify-fix.js";
import { withSession } from "../testkit.js";

/**
 * Owner ruling 2 — keep hunting after a defect; every finding can be replayed. A served app with
 * TWO independent bugs on two routes: an ambient 500 on the home page's load and a 503 on the
 * reports page. The mission must find the first, keep going, find the second, dedupe repeats by
 * fingerprint, and hand back replayable repro data that `verifyFix` can re-check.
 */

const state = { homeBroken: true, hideReportsLink: false };

const page = (body: string): string => `<!doctype html><html><body>${body}</body></html>`;
const PAGES: Record<string, () => string> = {
  "/app": () =>
    page(`<h1>Home</h1>
      ${state.hideReportsLink ? "" : '<a href="/reports">Reports</a>'}
      <a href="/settings">Settings</a>
      <button type="button">Refresh</button>
      <script>fetch("/api/boom").catch(() => undefined);</script>`),
  "/reports": () =>
    page(`<h1>Reports</h1><a href="/app">Home</a>
      <script>fetch("/api/reports/" + Math.floor(Math.random() * 1e6)).catch(() => undefined);</script>`),
  "/settings": () => page(`<h1>Settings</h1><a href="/app">Home</a><button type="button">Save</button>`),
};

let server: Server;
let origin: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0] ?? "";
    if (path === "/api/boom") {
      res.writeHead(state.homeBroken ? 500 : 200, { "content-type": "application/json" }).end("{}");
      return;
    }
    if (path.startsWith("/api/reports/")) {
      res.writeHead(503, { "content-type": "application/json" }).end("{}");
      return;
    }
    const render = PAGES[path];
    if (render === undefined) {
      res.writeHead(404).end("not found");
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(render());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (addr === null || typeof addr === "string") throw new Error("server has no port");
  origin = `http://127.0.0.1:${(addr satisfies AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
});

const port = new PlaywrightBrowserPort();
async function freshSession(): Promise<VerifySession> {
  const session = await port.open({ headless: true, allowedOrigins: [origin], baseUrl: origin });
  const actor = CastActor.named("verify").whoCan(new BrowseTheWeb(session, [origin]));
  return { page: session.page, actor, close: () => session.close() };
}

async function hunt(): Promise<AdversarialOutcome> {
  return withSession(
    "adv-hunt-",
    async (session) => {
      const actor = CastActor.named("hunter").whoCan(new BrowseTheWeb(session, [origin]));
      return runAdversarialMission({
        page: session.page,
        actor,
        judgment: new FakeJudgmentGateway({ looksBroken: { kind: "noul", value: false, probability: 0.1 } }),
        generation: new FakeGenerationGateway({ "triage.narrative": { summary: "server error", likelyCause: "backend" } }),
        seedUrl: `${origin}/app`,
        allowlist: [origin],
        strategies: ["visit-route", "nav-during-pending"],
        bounds: { maxDecisions: 6 },
      });
    },
    origin,
  );
}

describe("adversarial — keeps hunting after a defect (owner ruling 2)", () => {
  it(
    "finds the ambient 500, KEEPS GOING to find the second route's 503, and dedupes repeats by fingerprint",
    async () => {
      state.homeBroken = true;
      state.hideReportsLink = false;
      const result = await hunt();

      expect(result.outcome).toBe("defects-found");
      expect(result.stop).toBe("step-budget");
      // Seed load + 6 strategy steps: the run did not stop at the first defect.
      expect(result.transcript).toHaveLength(7);

      const home = result.defects.find((d) => d.title === "HTTP 500 from /api/boom");
      const reports = result.defects.find((d) => d.title === "HTTP 503 from /api/reports/:id");
      expect(home).toBeDefined();
      expect(reports).toBeDefined();
      expect(result.defects).toHaveLength(2);

      // The ambient defect: seen on the seed load; its repro is just the navigation.
      expect(home?.firstSeenStep).toBe(1);
      expect(home?.repro.recordingStepIndex).toBe(0);
      expect(home?.repro.steps.map((s) => s.strategy)).toEqual(["seed-load"]);
      expect(home?.route).toBe("/app");
      // Back on /app via the Home link, the SAME bug fired again: one defect, more occurrences.
      expect(home?.occurrences).toBeGreaterThan(1);
      expect(home?.triage).toEqual({ status: "available", summary: "server error", likelyCause: "backend" });

      // The second defect was found AFTER the first, by following a link (repro includes the click).
      expect(reports?.firstSeenStep).toBeGreaterThan(1);
      const lastReproStep = reports?.repro.steps.at(-1);
      expect(lastReproStep?.step).toBe(reports?.firstSeenStep);
      expect(reports?.repro.steps.some((s) => s.strategy === "visit-route" && s.target === 'link "Reports"')).toBe(true);
      expect(reports?.repro.recordingStepIndex).toBeGreaterThan(0);
      // The 503's id segment was random per load; the fingerprint normalizes it away.
      expect(reports?.fingerprint).toMatch(/^[0-9a-f]{16}$/);
    },
    120_000,
  );

  it(
    "verifyFix replays each repro in a fresh session: still-reproduces → fixed once the bug is gone → inconclusive when the path is unreachable",
    async () => {
      state.homeBroken = true;
      state.hideReportsLink = false;
      const result = await hunt();
      const home = result.defects.find((d) => d.title === "HTTP 500 from /api/boom");
      const reports = result.defects.find((d) => d.title === "HTTP 503 from /api/reports/:id");
      if (home === undefined || reports === undefined) throw new Error("expected both defects");

      const check = (d: typeof home) =>
        verifyFix({
          recording: result.recording,
          recordingStepIndex: d.repro.recordingStepIndex,
          fingerprint: d.fingerprint,
          defectKind: d.kind,
          openSession: freshSession,
          settleCeilingMs: 5_000,
        });

      expect((await check(home)).verdict).toBe("still-reproduces");
      const stillReports = await check(reports);
      expect(stillReports.verdict).toBe("still-reproduces");
      expect(stillReports.replay).toEqual({ outcome: "completed" });

      state.homeBroken = false; // "ship the fix"
      const fixed = await check(home);
      expect(fixed.verdict).toBe("fixed");
      expect(fixed.observedFingerprints).not.toContain(home.fingerprint);

      state.hideReportsLink = true; // the path to the second bug no longer exists
      const unreachable = await check(reports);
      expect(unreachable.verdict).toBe("inconclusive");
      expect(unreachable.replay.outcome).toBe("failed");

      // An invariant defect cannot be re-checked by replay alone: never reported fixed.
      const invariant = await verifyFix({
        recording: result.recording,
        recordingStepIndex: 0,
        fingerprint: "0000000000000000",
        defectKind: "invariant",
        openSession: freshSession,
      });
      expect(invariant.verdict).toBe("inconclusive");
      state.homeBroken = true;
      state.hideReportsLink = false;
    },
    180_000,
  );
});
