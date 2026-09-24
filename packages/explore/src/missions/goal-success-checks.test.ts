import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FakeGenerationGateway } from "@jevitate/ai-core";
import { BrowseTheWeb, CastActor } from "@jevitate/screenplay";
import { runGoalBasedMission, type GoalBasedResult } from "./goal-based.js";
import type { SuccessCheck } from "../success-checks.js";
import { ScriptedJudge, withSession, type ScriptedStep } from "../testkit.js";

/**
 * #65 — catching a silent save. Three served profile pages share one server-side record:
 *
 *  - `/broken/profile` — Save shows a "Saved" toast but sends nothing (the silent no-op);
 *  - `/good/profile`   — Save PUTs the value, the server persists it, then the toast shows;
 *  - `/failing/profile` — Save PUTs, the server answers 500, the page still says "Saved".
 *
 * The page's value is rendered from the server's record, so only a reload tells a persisted value
 * from local UI state. The goal run types "Litmus" into Last name and clicks Save.
 */

const record = { last: "Lovelace" };
let puts = 0;

const page = (variant: string): string => `<!doctype html><html><body>
  <h1>Profile</h1>
  <label>Last name <input data-testid="last" aria-label="Last name" value="${record.last}" /></label>
  <button type="button" id="save">Save</button>
  <div role="status" id="toast"></div>
  <script>
    // Only a RELOAD of the page (a second load in this tab) calls this endpoint.
    if (sessionStorage.getItem("loaded") === "1") fetch("/api/reloaded").catch(() => undefined);
    sessionStorage.setItem("loaded", "1");
    document.getElementById("save").addEventListener("click", async () => {
      const last = document.querySelector("[data-testid=last]").value;
      if (${JSON.stringify(variant)} !== "broken") {
        await fetch("/api/${variant}/profile", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ last }) });
      }
      document.getElementById("toast").textContent = "Saved";
    });
  </script>
</body></html>`;

let server: Server;
let origin: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0] ?? "";
    const m = /^\/(broken|good|failing)\/profile$/.exec(path);
    if (m !== null && m[1] !== undefined) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(page(m[1]));
      return;
    }
    if (req.method === "PUT" && (path === "/api/good/profile" || path === "/api/failing/profile")) {
      puts += 1;
      let body = "";
      req.on("data", (c: Buffer) => (body += c.toString()));
      req.on("end", () => {
        if (path === "/api/failing/profile") {
          res.writeHead(500, { "content-type": "application/json" }).end("{}");
          return;
        }
        record.last = (JSON.parse(body) as { last: string }).last;
        res.writeHead(200, { "content-type": "application/json" }).end("{}");
      });
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

beforeEach(() => {
  record.last = "Lovelace";
  puts = 0;
});

const VALUE_ON_PAGE: SuccessCheck = {
  kind: "page",
  assertion: { kind: "valueEquals", target: { testId: "last" }, value: "Litmus" },
};
const PERSISTED: SuccessCheck = {
  kind: "reloadThen",
  assertion: { kind: "valueEquals", target: { testId: "last" }, value: "Litmus" },
};
const SAVE_SENT: SuccessCheck = { kind: "requestMade", method: "PUT", pathGlob: "/api/*/profile" };
const SAVE_OK: SuccessCheck = { kind: "responseStatus", method: "PUT", pathGlob: "/api/*/profile", status: { class: 2 } };

// Controls on the page: [0] Last name, [1] Save.
const EDIT_AND_SAVE: ScriptedStep[] = [{ op: "type", target: "0" }, { op: "click", target: "1" }, { op: "done" }];

async function save(variant: string, checks: SuccessCheck[], steps: ScriptedStep[] = EDIT_AND_SAVE): Promise<GoalBasedResult> {
  return withSession(
    "goal-checks-",
    async (session) => {
      const actor = CastActor.named("saver").whoCan(new BrowseTheWeb(session, [origin]));
      return runGoalBasedMission({
        actor,
        judge: new ScriptedJudge(steps),
        gen: new FakeGenerationGateway({ "form.value": { text: "Litmus" } }),
        goal: "change the last name to Litmus and save it",
        allowlist: [origin],
        startUrl: `${origin}/${variant}/profile`,
        successChecks: checks,
        oracleTimeoutMs: 500,
      });
    },
    origin,
  );
}

describe("goal mission — a save that shows success but persists nothing FAILS (#65)", () => {
  it(
    "reloadThen:valueEquals catches it, while the same check without the reload is fooled",
    async () => {
      const result = await save("broken", [VALUE_ON_PAGE, PERSISTED]);
      expect(result.assertionPassed).toBe(false);
      expect(result.outcome).toBe("blocked");
      expect(result.checks).toEqual([
        { check: "valueEquals:testId=last|Litmus", passed: true, detail: "held on the final page" },
        { check: "reloadThen:valueEquals:testId=last|Litmus", passed: false, detail: "did not hold after a reload" },
      ]);
      expect(puts).toBe(0);
    },
    120_000,
  );

  it(
    "requestMade catches it: no save request was ever sent",
    async () => {
      const result = await save("broken", [SAVE_SENT]);
      expect(result.assertionPassed).toBe(false);
      expect(result.checks).toEqual([
        {
          check: "requestMade:PUT /api/*/profile",
          passed: false,
          detail: expect.stringMatching(/^no PUT request matched \/api\/\*\/profile \(\d+ requests captured\)$/),
        },
      ]);
    },
    120_000,
  );

  it(
    "responseStatus catches a save the server rejected while the page still says Saved",
    async () => {
      const result = await save("failing", [SAVE_SENT, SAVE_OK]);
      expect(result.assertionPassed).toBe(false);
      expect(result.checks[0]).toMatchObject({ passed: true });
      expect(result.checks[1]).toEqual({
        check: "responseStatus:PUT /api/*/profile=2xx",
        passed: false,
        detail: "expected 2xx, got 500 for 1 matching request(s)",
      });
    },
    120_000,
  );
});

describe("goal mission — a correct save passes every check (#65)", () => {
  it(
    "requestMade, responseStatus and reloadThen:valueEquals all hold",
    async () => {
      const result = await save("good", [SAVE_SENT, SAVE_OK, PERSISTED]);
      expect(result.checks.map((c) => [c.check, c.passed])).toEqual([
        ["requestMade:PUT /api/*/profile", true],
        ["responseStatus:PUT /api/*/profile=2xx", true],
        ["reloadThen:valueEquals:testId=last|Litmus", true],
      ]);
      expect(result.assertionPassed).toBe(true);
      expect(result.outcome).toBe("succeeded");
      expect(record.last).toBe("Litmus");
    },
    120_000,
  );

  it(
    "the goal loop can choose reload itself; it is recorded as a navigation and the checks still hold",
    async () => {
      const result = await save("good", [SAVE_SENT, PERSISTED], [
        { op: "type", target: "0" },
        { op: "click", target: "1" },
        { op: "reload" },
        { op: "done" },
      ]);
      expect(result.outcome).toBe("succeeded");
      const reload = result.transcript.find((e) => e.op === "reload");
      expect(reload?.actOk).toBe(true);
      const kinds = result.recording.pages.flatMap((p) => p.steps.map((s) => s.step.kind));
      expect(kinds).toEqual(["navigate", "fill", "click", "navigate"]);
    },
    120_000,
  );

  it(
    "the oracle's own reload never counts as a request the run made",
    async () => {
      // /api/reloaded is requested only by a reload. The run never reloads; the oracle does (for
      // reloadThen) — and that request must not satisfy the run's network check.
      const result = await save("broken", [PERSISTED, { kind: "requestMade", method: "GET", pathGlob: "/api/reloaded" }], [
        { op: "done" },
      ]);
      expect(result.checks[1]).toMatchObject({ check: "requestMade:GET /api/reloaded", passed: false });
      // …while a reload the RUN chose does count.
      const chosen = await save("broken", [{ kind: "requestMade", method: "GET", pathGlob: "/api/reloaded" }], [
        { op: "reload" },
        { op: "done" },
      ]);
      expect(chosen.checks[0]).toMatchObject({ passed: true });
    },
    120_000,
  );
});

describe("goal mission — needs at least one success check", () => {
  it("refuses to start without one (a setup error, before any navigation)", async () => {
    await expect(
      withSession(
        "goal-checks-none-",
        async (session) =>
          runGoalBasedMission({
            actor: CastActor.named("x").whoCan(new BrowseTheWeb(session, [origin])),
            judge: new ScriptedJudge([{ op: "done" }]),
            gen: new FakeGenerationGateway(),
            goal: "g",
            allowlist: [origin],
            startUrl: `${origin}/good/profile`,
          }),
        origin,
      ),
    ).rejects.toThrow(/at least one success check/);
  });
});
