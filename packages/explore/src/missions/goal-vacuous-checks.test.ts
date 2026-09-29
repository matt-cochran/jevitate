import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeGenerationGateway } from "@jevitate/ai-core";
import { BrowseTheWeb, CastActor } from "@jevitate/screenplay";
import { runGoalBasedMission, type GoalBasedResult } from "./goal-based.js";
import type { SuccessCheck } from "../success-checks.js";
import { ScriptedJudge, withSession, type ScriptedStep } from "../testkit.js";

/**
 * #202 — a success check satisfied BEFORE the goal's own work happens cannot verify the goal: an
 * empty result container that renders at once, a request the page load fires. Vacuous checks fail
 * by default (named in `warnings`); `allowVacuousChecks` downgrades them to a warning. A check the
 * run's action genuinely satisfied still passes. Served pages, real Chromium, scripted judges only.
 */

const PAGES: Record<string, string> = {
  // The results container is on the page (empty) from the start; Add fills it.
  "/list-empty": `<!doctype html><html><body><h1>Groceries</h1>
    <section data-testid="list"><h2>Results</h2><ul id="ul"></ul></section>
    <button type="button" onclick="const li = document.createElement('li'); li.dataset.testid = 'item'; li.textContent = 'Milk'; document.getElementById('ul').append(li)">Add</button>
    </body></html>`,
  // The results container only appears once Add was clicked.
  "/list-late": `<!doctype html><html><body><h1>Groceries</h1>
    <div id="slot"></div>
    <button type="button" onclick="document.getElementById('slot').innerHTML = '<section data-testid=&quot;list&quot;><h2>Results</h2><ul><li>Milk</li></ul></section>'">Add</button>
    </body></html>`,
  // The page load fetches /api/items; Refresh does nothing on the network.
  "/poll": `<!doctype html><html><body><h1>Items</h1>
    <p id="n">loading</p>
    <button type="button" onclick="document.getElementById('n').textContent = 'refreshed'">Refresh</button>
    <script>fetch('/api/items').then(() => { document.getElementById('n').textContent = 'loaded'; });</script>
    </body></html>`,
  // The page load fetches /api/items AND Search fetches it again — the action's own request counts.
  "/search": `<!doctype html><html><body><h1>Items</h1>
    <p id="n">loading</p>
    <button type="button" onclick="fetch('/api/items?q=milk').then(() => { document.getElementById('n').textContent = 'searched'; })">Search</button>
    <script>fetch('/api/items').then(() => { document.getElementById('n').textContent = 'loaded'; });</script>
    </body></html>`,
};

let server: Server;
let origin: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0] ?? "";
    if (path === "/api/items") {
      res.writeHead(200, { "content-type": "application/json" }).end("[]");
      return;
    }
    const body = PAGES[path];
    if (body === undefined) {
      res.writeHead(404).end();
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
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const visible = (testId: string): SuccessCheck => ({ kind: "page", assertion: { kind: "visible", target: { testId } } });
const itemsFetched: SuccessCheck = { kind: "requestMade", method: "GET", pathGlob: "/api/items" };

async function run(path: string, steps: ScriptedStep[], checks: SuccessCheck[], allowVacuousChecks = false): Promise<GoalBasedResult> {
  return withSession(
    "goal-vacuous-",
    async (session) => {
      const actor = CastActor.named("vacuous").whoCan(new BrowseTheWeb(session, [origin]));
      return runGoalBasedMission({
        actor,
        judge: new ScriptedJudge(steps),
        gen: new FakeGenerationGateway({ "form.value": { text: "Milk" } }),
        goal: "add milk",
        allowlist: [origin],
        startUrl: `${origin}${path}`,
        successChecks: checks,
        oracleTimeoutMs: 300,
        waitOpMs: 300,
        bounds: { maxDecisions: 8 },
        ...(allowVacuousChecks ? { allowVacuousChecks: true } : {}),
      });
    },
    origin,
  );
}

describe("#202 — a success check satisfied before any action is vacuous", () => {
  it(
    "an empty container visible on the seed page FAILS the check, named in the result",
    async () => {
      // Controls: [0] Add.
      const result = await run("/list-empty", [{ op: "click", target: "0" }, { op: "done" }], [visible("list")]);
      expect(result.outcome).not.toBe("succeeded");
      expect(result.assertionPassed).toBe(false);
      expect(result.checks[0]?.passed).toBe(false);
      expect(result.checks[0]?.detail).toMatch(/^vacuous: held on the seed page at step 0, before any action/);
      // #209: the passing detail is no longer appended — "…; held on the final page" read as a pass.
      expect(result.checks[0]?.detail).not.toContain("held on the final page");
      expect(result.warnings).toContain("check 'visible:testId=list' held at step 0, before any action — it cannot verify the goal");
      expect(result.reason).toContain("cannot verify the goal");
      // #209: was `blocked` (exit 1, the same as an app blocker) — a vacuous check proves nothing
      // either way, so the run is `inconclusive`, naming the check.
      expect(result.outcome).toBe("inconclusive");
      expect(result.failure?.kind).toBe("vacuous-check");
      expect(result.failure?.message).toContain("'visible:testId=list'");
      // …and the transcript never said the goal was verified by it.
      expect(result.transcript.some((e) => (e.reason ?? "").includes("goal verified by success-condition"))).toBe(false);
    },
    120_000,
  );

  it(
    "--allow-vacuous-checks downgrades it to a warning",
    async () => {
      const result = await run("/list-empty", [{ op: "click", target: "0" }, { op: "done" }], [visible("list")], true);
      expect(result.outcome).toBe("succeeded");
      expect(result.warnings).toContain(
        "check 'visible:testId=list' held at step 0, before any action — it cannot verify the goal (allowed by --allow-vacuous-checks)",
      );
    },
    120_000,
  );

  it(
    "a stronger check on the same page (count of items, min=1) is not vacuous and passes",
    async () => {
      const result = await run(
        "/list-empty",
        [{ op: "click", target: "0" }, { op: "done" }],
        [{ kind: "page", assertion: { kind: "count", target: { testId: "item" }, min: 1 } }],
      );
      expect(result.outcome).toBe("succeeded");
      expect(result.warnings ?? []).toEqual([]);
    },
    120_000,
  );

  it(
    "genuine: a container that only appears after the action still passes, with no warning",
    async () => {
      const result = await run("/list-late", [{ op: "click", target: "0" }, { op: "done" }], [visible("list")]);
      expect(result.outcome).toBe("succeeded");
      expect(result.warnings ?? []).toEqual([]);
    },
    120_000,
  );

  it(
    "a requestMade matched only by the page load's request FAILS the check, named in the result",
    async () => {
      // Controls: [0] Refresh (no request).
      const result = await run("/poll", [{ op: "click", target: "0" }, { op: "done" }], [itemsFetched]);
      expect(result.outcome).not.toBe("succeeded");
      expect(result.checks[0]?.passed).toBe(false);
      expect(result.checks[0]?.detail).toMatch(/^vacuous: matched only by request\(s\) sent before the run's first action/);
      // #209: only vacuous checks failed — the run proved nothing: inconclusive, not blocked.
      expect(result.outcome).toBe("inconclusive");
      expect(result.failure?.kind).toBe("vacuous-check");
      expect(result.warnings?.some((w) => w.startsWith("check 'requestMade:GET /api/items' held at step 0, before any action — it cannot verify the goal"))).toBe(
        true,
      );
    },
    120_000,
  );

  it(
    "--allow-vacuous-checks: the page-load request counts again, with a warning",
    async () => {
      const result = await run("/poll", [{ op: "click", target: "0" }, { op: "done" }], [itemsFetched], true);
      expect(result.outcome).toBe("succeeded");
      expect(result.warnings?.some((w) => w.includes("(allowed by --allow-vacuous-checks)"))).toBe(true);
    },
    120_000,
  );

  it(
    "genuine: a request the action fired counts (even when the page load fired a matching one too)",
    async () => {
      // Controls: [0] Search.
      const result = await run("/search", [{ op: "click", target: "0" }, { op: "done" }], [itemsFetched]);
      expect(result.outcome).toBe("succeeded");
      expect(result.checks[0]?.detail).toBe("1 matching request(s)");
      expect(result.warnings ?? []).toEqual([]);
    },
    120_000,
  );
});
