import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeGenerationGateway } from "@jevitate/ai-core";
import { BrowseTheWeb, CastActor } from "@jevitate/screenplay";
import { runGoalBasedMission, type GoalBasedResult } from "./goal-based.js";
import type { MinEffortRequest } from "../run-depth.js";
import { ScriptedJudge, withSession, type ScriptedStep, useSkippingTime } from "../testkit.js";

// #304: Node and page time skip idle waits (settle windows, hang ceilings, polls); assertions unchanged.
useSkippingTime({ per: "all" });

/**
 * #424 — open-ended find-out goals concluded after one page with "answer not found". End to end (real
 * Chromium, a small multi-tab app, a scripted model and a deterministic answer generator):
 *
 *  - an open-ended find-out's early `report` / `blocked` is deferred until the minimum effort (actions,
 *    distinct page states) is met, and the run explores the tabs before it concludes;
 *  - a run that still cannot ground an answer returns a grounded partial report (per page: what it
 *    showed, what was tried) and its depth;
 *  - a model that insists on ending is not refused forever; a narrow goal keeps concluding at once;
 *    explicit minimums apply to any goal and are capped by the budget with a warning.
 */

const NAV = `<nav><a href="/">Overview</a> <a href="/projects">Projects</a> <a href="/reports">Reports</a> <a href="/settings">Settings</a></nav>`;
const page = (body: string): string => `<!doctype html><html><head><title>Tool</title></head><body>${NAV}<main>${body}</main></body></html>`;

const PAGES: Record<string, string> = {
  "/": page(`<h1>Overview</h1><p>Overview: 3 projects active</p><p>Last sync finished 2 minutes ago.</p>`),
  "/projects": page(`<h1>Projects</h1><ul><li>Apollo — on track</li><li>Gemini — at risk</li><li>Mercury — archived</li></ul>`),
  "/reports": page(`<h1>Reports</h1><p role="alert">Error: the weekly report failed to load.</p>`),
  "/settings": page(`<h1>Settings</h1><p>Notifications are turned off.</p>`),
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

const OPEN_ENDED = "Use this tool's main features and report what works and every error you see.";
const GROUNDED = { answer: "3 projects are active.", claims: [{ claim: "3 projects are active", quote: "Overview: 3 projects active" }] };
const NONE = { answer: null, claims: [] };

async function run(goal: string, steps: ScriptedStep[], answer: unknown, opts: { maxActions?: number; maxDecisions?: number; minEffort?: MinEffortRequest } = {}): Promise<GoalBasedResult> {
  return withSession(
    "findout-min-effort-",
    async (session) => {
      const actor = CastActor.named("reader").whoCan(new BrowseTheWeb(session, [origin]));
      return runGoalBasedMission({
        actor,
        judge: new ScriptedJudge(steps),
        gen: new FakeGenerationGateway({ "goal.answer": answer }),
        goal,
        allowlist: [origin],
        startUrl: `${origin}/`,
        waitOpMs: 300,
        bounds: { maxActions: opts.maxActions ?? 6, maxDecisions: opts.maxDecisions ?? 14 },
        ...(opts.minEffort === undefined ? {} : { minEffort: opts.minEffort }),
      });
    },
    origin,
  );
}

const reasons = (r: GoalBasedResult, op: string) => r.transcript.filter((e) => e.op === op).map((e) => e.reason ?? "");

describe("#424 — an open-ended find-out explores before it concludes", () => {
  it(
    "an early report and blocked are deferred; the run visits the tabs, then its grounded report is accepted",
    async () => {
      // Nav indices on every page: [0] Overview, [1] Projects, [2] Reports, [3] Settings.
      const r = await run(OPEN_ENDED, [{ op: "report" }, { op: "blocked" }, { op: "click", target: "1" }, { op: "click", target: "2" }, { op: "click", target: "3" }, { op: "report" }], GROUNDED);
      const reports = reasons(r, "report");
      // budget 6 → the open-ended default is scaled to 3 actions and 4 distinct states.
      expect(reports[0]).toMatch(/report deferred \(1\/3\): the minimum exploration effort is not met yet — 0 of 3 actions, 1 of 4 distinct page states so far/);
      expect(reports[0]).toMatch(/untried here: "Overview", "Projects", "Reports", "Settings"|pages not yet seen: \/projects, \/reports, \/settings/);
      // The `blocked` became a report attempt on that state (#207), deferred again.
      expect(reports[1]).toMatch(/report deferred \(2\/3\)/);
      expect(reports.at(-1)).toMatch(/report accepted/);
      expect(r.outcome).toBe("succeeded");
      expect(r.run.answer?.text).toBe("3 projects are active.");
      expect(r.run.depth).toMatchObject({ actions: 3, distinctPages: 4, minimum: { minActions: 3, minDistinctStates: 4, source: "open-ended", met: true } });
      expect(r.run.depth.distinctStates).toBeGreaterThanOrEqual(4);
      expect(r.run.partialReport).toBeUndefined();
    },
    120_000,
  );

  it(
    "a run that cannot ground an answer returns a grounded partial report per page, with what it tried and its depth",
    async () => {
      const r = await run(OPEN_ENDED, [{ op: "click", target: "1" }, { op: "click", target: "2" }, { op: "click", target: "3" }, { op: "report" }], NONE);
      expect(r.outcome).not.toBe("succeeded");
      expect(r.reason ?? r.run.outcome).toBeDefined();
      const partial = r.run.partialReport;
      expect(partial).toBeDefined();
      expect(partial!.note).toMatch(/answer not found \(pages seen: /);
      const byUrl = new Map(partial!.states.map((s) => [s.url, s]));
      expect([...byUrl.keys()]).toEqual(["/", "/projects", "/reports", "/settings"]);
      expect(byUrl.get("/")!.seen).toContain("Overview: 3 projects active");
      expect(byUrl.get("/projects")!.seen).toEqual(expect.arrayContaining(["Apollo — on track", "Gemini — at risk"]));
      // The goal asks for errors: the error text is reported as seen.
      expect(byUrl.get("/reports")!.seen).toContain("Error: the weekly report failed to load.");
      expect(byUrl.get("/")!.tried[0]).toMatchObject({ op: "click", ok: true, result: "led to /projects" });
      expect(byUrl.get("/")!.controls).toEqual(expect.arrayContaining(["Overview", "Projects"]));
      // Every seen line is the page's own text — nothing the model said.
      for (const s of partial!.states) for (const line of s.seen) expect(Object.values(PAGES).some((h) => h.includes(line))).toBe(true);
      expect(r.run.depth).toMatchObject({ actions: 3, distinctPages: 4, formsSubmitted: 0 });
    },
    120_000,
  );
});

describe("#424 — the minimum is bounded and opt-in for narrow goals", () => {
  it(
    "a model that insists on reporting is deferred 3 times in a row, then its grounded answer stands",
    async () => {
      const r = await run(OPEN_ENDED, [{ op: "report" }], GROUNDED);
      const reports = reasons(r, "report");
      expect(reports.slice(0, 3).every((x) => /report deferred/.test(x))).toBe(true);
      expect(reports[3]).toMatch(/report accepted/);
      expect(r.outcome).toBe("succeeded");
      expect(r.run.depth.minimum).toMatchObject({ met: false });
    },
    120_000,
  );

  it(
    "a narrow find-out concludes on its first grounded report (no default minimum)",
    async () => {
      const r = await run("Find out how many projects are active.", [{ op: "report" }], GROUNDED);
      expect(reasons(r, "report")[0]).toMatch(/report accepted/);
      expect(r.run.depth.minimum).toBeUndefined();
      expect(r.run.depth).toMatchObject({ actions: 0, distinctStates: 1, distinctPages: 1 });
    },
    120_000,
  );

  it(
    "explicit minimums apply to a narrow goal, are capped by the budget with a warning, and an answer deferred before the budget ran out is the answer",
    async () => {
      const r = await run("Find out how many projects are active.", [{ op: "report" }, { op: "click", target: "1" }, { op: "click", target: "2" }, { op: "wait" }], GROUNDED, {
        maxActions: 2,
        minEffort: { minActions: 5 },
      });
      expect(r.warnings).toEqual(expect.arrayContaining([expect.stringMatching(/--min-actions 5 exceeds the run's budget \(2 actions, 14 decisions\): capped at 2/)]));
      expect(reasons(r, "report")[0]).toMatch(/report deferred \(1\/3\): the minimum exploration effort is not met yet — 0 of 2 actions/);
      expect(r.run.depth.minimum).toMatchObject({ minActions: 2, minDistinctStates: 0, source: "flags" });
      // The budget is spent before a second report: the deferred grounded answer is the run's answer.
      expect(r.run.answer?.text).toBe("3 projects are active.");
      expect(r.outcome).toBe("succeeded");
    },
    120_000,
  );
});
