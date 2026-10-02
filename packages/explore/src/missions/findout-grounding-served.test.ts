import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeGenerationGateway } from "@jevitate/ai-core";
import { BrowseTheWeb, CastActor } from "@jevitate/screenplay";
import { runGoalBasedMission, type GoalBasedResult } from "./goal-based.js";
import { ScriptedJudge, withSession, type ScriptedStep, useSkippingTime } from "../testkit.js";

// #304: Node and page time skip idle waits (settle windows, hang ceilings, polls); assertions unchanged.
useSkippingTime({ per: "all" });

/**
 * Find-out grounding, end to end (real Chromium, served pages, a deterministic generator):
 *
 *  - #236: a correct answer formatted as a numbered markdown list (`1. … 6.`) was rejected 3/3 — the
 *    list markers were read as figures no page shows.
 *  - #234: a correct list answer (the page's section headings, real but not contiguous on the page)
 *    quoted one heading per line was rejected as "quote not found", resubmitted identically 3×.
 *  - #238: "none exists" — the right answer to "check whether there is a status indicator" — could
 *    not be reported at all (an absence has no positive quote); the run ended `blocked` /
 *    `defects-found`. Now: an absence answer once the run has seen enough of the app (a coverage floor
 *    over the top-level navigation), and `inconclusive` (never a defect) when it has not.
 */

const NAV = `<nav><a href="/home">Home</a> <a href="/settings">Settings</a> <a href="/billing">Billing</a> <a href="/help">Help</a></nav>`;

const PAGES: Record<string, string> = {
  "/home": `<!doctype html><html><body>${NAV}<main><h1>Home</h1><p>Welcome back. Your studies are listed below.</p></main></body></html>`,
  "/settings": `<!doctype html><html><body>${NAV}<main><h1>Workspace settings</h1>
<h2>Team</h2><p>People in this workspace. Invite teammates and manage roles.</p>
<h2>Credits</h2><p>Buy credits for your studies.</p>
<h2>Plans</h2><p>No subscription</p>
<ul><li>Design Partner — 250 credits / month for $300/month</li><li>Startup Program — 150 credits / month for $300/month</li><li>Premium (annual) — 2,000 credits / month for $45,000/year</li></ul>
<h2>API keys</h2><p>No keys yet.</p>
<h2>Delete workspace or account</h2><p>This cannot be undone.</p></main></body></html>`,
  "/billing": `<!doctype html><html><body>${NAV}<main><h1>Billing</h1><p>No invoices yet.</p></main></body></html>`,
  "/help": `<!doctype html><html><body>${NAV}<main><h1>Help</h1><p>Read the docs.</p></main></body></html>`,
  "/single": `<!doctype html><html><body><main><h1>Single page</h1><p>Nothing else here.</p><button type="button">Refresh</button></main></body></html>`,
};

let server: Server;
let origin: string;
beforeAll(async () => {
  server = createServer((req, res) => {
    const html = PAGES[(req.url ?? "/").split("?")[0] ?? "/"];
    res.writeHead(html === undefined ? 404 : 200, { "content-type": "text/html; charset=utf-8" }).end(html ?? "not found");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function run(path: string, goal: string, steps: ScriptedStep[], answer: unknown, maxDecisions = 8): Promise<GoalBasedResult> {
  return withSession(
    "findout-grounding-",
    async (session) => {
      const actor = CastActor.named("reader").whoCan(new BrowseTheWeb(session, [origin]));
      return runGoalBasedMission({
        actor,
        judge: new ScriptedJudge(steps),
        gen: new FakeGenerationGateway({ "goal.answer": answer }),
        goal,
        allowlist: [origin],
        startUrl: `${origin}${path}`,
        waitOpMs: 300,
        bounds: { maxDecisions },
      });
    },
    origin,
  );
}

const reports = (r: GoalBasedResult) => r.transcript.filter((e) => e.op === "report").map((e) => e.reason ?? "");

describe("find-out list answers ground (#236, #234)", () => {
  it(
    "#236: a numbered-list answer whose every real figure is on the page is accepted on the first report",
    async () => {
      const answer = {
        answer:
          "You are currently not subscribed to any plan. The available plans are:\n1. **Design Partner** — 250 credits / month for $300/month.\n2. **Startup Program** — 150 credits / month for $300/month.\n3. **Premium (annual)** — 2,000 credits / month for $45,000/year.",
        claims: [
          { claim: "You are currently not subscribed to any plan.", quote: "No subscription" },
          { claim: "Design Partner: 250 credits / month for $300/month", quote: "Design Partner — 250 credits / month for $300/month" },
          { claim: "Startup Program: 150 credits / month for $300/month", quote: "Startup Program — 150 credits / month for $300/month" },
          { claim: "Premium (annual): 2,000 credits / month for $45,000/year", quote: "Premium (annual) — 2,000 credits / month for $45,000/year" },
        ],
      };
      const r = await run("/settings", "See what plan you're subscribed to and what other plans you could change to. Finish by reporting the current plan and the available plans.", [{ op: "report" }], answer);
      expect(reports(r)[0]).toMatch(/report accepted/);
      expect(r.outcome).toBe("succeeded");
      expect(r.run.answer?.text).toContain("1. **Design Partner**");
    },
    90_000,
  );

  it(
    "#234: section headings quoted one per line (non-contiguous on the page) ground as the page's list",
    async () => {
      const quote = "Workspace settings\nTeam\nPeople in this workspace. Invite teammates and manage roles.\nCredits\nPlans\nAPI keys\nDelete workspace or account";
      const answer = { answer: "Team, Credits, Plans, API keys, Delete workspace or account", claims: [{ claim: "The settings page's sections", quote }] };
      const r = await run("/settings", "Find where your account and workspace settings live. Finish by reporting which sections are there.", [{ op: "report" }], answer);
      expect(reports(r)[0]).toMatch(/report accepted/);
      expect(r.outcome).toBe("succeeded");
      expect(r.run.answer?.evidence[0]).toMatchObject({ grounded: true, source: "page-text" });
    },
    90_000,
  );

  it(
    "#234: a stitched quote with a line the page lacks is rejected with a repairable reason, and its identical resubmission is named as a repeat",
    async () => {
      const answer = { answer: "Team and Billing history", claims: [{ claim: "The settings page's sections", quote: "Team\nBilling history" }] };
      const r = await run("/settings", "Find where your account and workspace settings live. Finish by reporting which sections are there.", [{ op: "report" }], answer);
      const rs = reports(r);
      expect(rs[0]).toMatch(/lines are not all on one page in that order — quote one contiguous passage, or give one claim per list entry/);
      expect(rs[1]).toMatch(/already rejected in this run — change the quotes/);
      expect(r.outcome).not.toBe("succeeded");
    },
    90_000,
  );
});

describe("#238 — 'none exists' is an answer, once the run has looked", () => {
  const GOAL =
    "Check whether the product is currently having problems. Finish by reporting whether you found any system-status indicator and what it says (saying none exists is a valid answer).";
  const NONE = { answer: null, claims: [] };

  it(
    "a report from the start page is refused (below the coverage floor, naming the unseen navigation); after visiting the nav the absence is the answer",
    async () => {
      // /home's controls: [0] Home, [1] Settings, [2] Billing, [3] Help.
      const r = await run("/home", GOAL, [{ op: "report" }, { op: "click", target: "1" }, { op: "report" }], NONE);
      const rs = reports(r);
      expect(rs[0]).toMatch(/"none exists" is not established yet: the run has seen \/home, below the floor of 2 of the 4 top-level navigation pages — not yet seen: \/settings, \/billing, \/help/);
      expect(rs[1]).toMatch(/report accepted/);
      expect(r.outcome).toBe("succeeded");
      expect(r.run.answer).toMatchObject({ absent: true, searched: ["/home", "/settings"], evidence: [] });
      expect(r.run.answer?.text).toBe("not present — none of the pages seen shows it (pages seen: /home, /settings)");
    },
    90_000,
  );

  it(
    "a run that never looks beyond its start page ends inconclusive (insufficient coverage), never blocked / a defect",
    async () => {
      const r = await run("/home", GOAL, [{ op: "report" }], NONE);
      expect(r.outcome).toBe("inconclusive");
      expect(r.run.failure).toMatchObject({ kind: "insufficient-coverage" });
      expect(r.reason).toMatch(/"none exists" is not established yet/);
      expect(r.run.answer).toBeUndefined();
    },
    90_000,
  );

  it(
    "a site without navigation needs two distinct pages; a goal that does not admit absence still ends 'answer not found'",
    async () => {
      const single = await run("/single", GOAL, [{ op: "report" }], NONE);
      expect(single.outcome).toBe("inconclusive");
      expect(single.reason).toMatch(/below the floor of 2 distinct pages/);

      const plain = await run("/home", "Find out the price of the Pro plan", [{ op: "report" }, { op: "click", target: "1" }, { op: "report" }, { op: "report" }], NONE);
      expect(plain.outcome).toBe("blocked");
      expect(plain.reason).toMatch(/answer not found \(pages seen: \/home, \/settings\)/);
    },
    90_000,
  );
});
