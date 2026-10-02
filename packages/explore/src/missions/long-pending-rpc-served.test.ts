import { createServer, type ServerResponse, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FakeGenerationGateway } from "@jevitate/ai-core";
import { BrowseTheWeb, CastActor } from "@jevitate/screenplay";
import { runGoalBasedMission, type GoalBasedResult } from "./goal-based.js";
import { ScriptedJudge, withSession, type ScriptedStep, useSkippingTime } from "../testkit.js";

// #304: Node and page time skip idle waits (settle windows, hang ceilings, polls); assertions unchanged.
useSkippingTime({ per: "all" });

/**
 * #283 on a served page (real Chromium). "Run the simulation →" sends a gRPC-web UNARY request
 * (`POST /simuli.intelligence.IntelligenceService/ProductIntelligenceSprint`) that the server holds
 * open while the job runs — in the field, ~11 minutes. Past the long-poll threshold the settle rule
 * treats it as background (so perception does not hang on it), and before the fix it was forgotten
 * everywhere else too: `requestMade` saw only FINISHED requests ("no POST request matched … (31
 * requests captured)"), a `wait` reported "nothing is pending", and `blocked` went through — a false
 * `blocked` while the app was working.
 *
 * The field goal asks to "finish by reporting what happens", so (#286) its checks alone never meet it:
 * the run ends with a grounded `report` of what the page shows.
 */

const RPC = "/simuli.intelligence.IntelligenceService/ProductIntelligenceSprint";
let app: Server;
let origin: string;
/** How long the server holds the RPC open (ms); `null` = until the test tears it down. */
let holdMs: number | null = null;
const held: ServerResponse[] = [];
let rpcs = 0;

const pageHtml = `<!doctype html><html><body>
<h1>Pressure-test the bet</h1>
<button type="button" id="run">Run the simulation →</button>
<div style="height: 3000px"></div>
<p id="state">Not run yet</p>
<script>
  document.getElementById("run").addEventListener("click", async () => {
    document.getElementById("state").textContent = "Simulation running";
    const r = await fetch(${JSON.stringify(RPC)}, {
      method: "POST",
      headers: { "content-type": "application/grpc-web+proto", "x-grpc-web": "1" },
      body: new Uint8Array([0, 0, 0, 0, 0]),
    });
    document.getElementById("state").textContent = r.ok ? "Simulation finished" : "Simulation failed";
  });
</script>
</body></html>`;

beforeAll(async () => {
  app = createServer((req, res) => {
    if (req.method === "POST" && req.url === RPC) {
      rpcs += 1;
      req.resume();
      const answer = (): void => {
        if (!res.writableEnded) res.writeHead(200, { "content-type": "application/grpc-web+proto", "grpc-status": "0" }).end();
      };
      if (holdMs === null) held.push(res);
      else setTimeout(answer, holdMs);
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(pageHtml);
  });
  await new Promise<void>((resolve) => app.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
});
afterAll(async () => {
  for (const r of held) r.destroy();
  app.closeAllConnections();
  await new Promise<void>((resolve) => app.close(() => resolve()));
});
beforeEach(() => {
  rpcs = 0;
});

const REPORT_GOAL = "Pressure-test the bet by running the simulation. Finish by reporting what happens after you start it.";
/** The grounded answer a `report` gives, quoting the page's own state line. */
const answer = (state: string) => ({ answer: state, claims: [{ claim: `The page says ${state}`, quote: state }] });

async function run(
  steps: ScriptedStep[],
  jobWaitMs?: number,
  finished = false,
  { goal = REPORT_GOAL, state = "Simulation finished" }: { goal?: string; state?: string } = {},
): Promise<GoalBasedResult> {
  return withSession(
    "long-pending-rpc-",
    async (session) => {
      const actor = CastActor.named("sim").whoCan(new BrowseTheWeb(session, [origin]));
      return runGoalBasedMission({
        actor,
        judge: new ScriptedJudge(steps),
        gen: new FakeGenerationGateway({ "goal.answer": answer(state) }),
        goal,
        allowlist: [origin],
        startUrl: `${origin}/decisions/demo`,
        successChecks: [{ kind: "requestMade", method: "POST", pathGlob: RPC }],
        // Optionally also require the job's own end state, so the checks cannot hold while it runs.
        ...(finished ? { successAssertion: { kind: "visible" as const, target: { text: "Simulation finished" } } } : {}),
        // The long-poll threshold, lowered so the held RPC turns "background" for settling quickly.
        settle: { longPollMs: 1_000 },
        waitOpMs: 500,
        bounds: { maxDecisions: 6 },
        ...(jobWaitMs === undefined ? {} : { jobWaitMs }),
      });
    },
    origin,
  );
}

const notes = (r: GoalBasedResult): string[] => r.transcript.map((e) => e.reason ?? "");

describe("a long-pending in-flight unary RPC (#283)", () => {
  it(
    "a wait observes the in-flight write until it resolves (never 'nothing is pending'); requestMade matches it",
    async () => {
      holdMs = 5_000;
      // Controls: [0] Run the simulation →.
      const result = await run([{ op: "click", target: "0" }, { op: "wait" }, { op: "report" }]);
      expect(rpcs).toBe(1);
      const waited = notes(result).find((n) => n.startsWith("waited"));
      expect(waited).toContain(`POST ${RPC} (sent by an earlier click)`);
      expect(waited).not.toMatch(/nothing is pending/);
      expect(result.checks[0]).toMatchObject({ passed: true });
      expect(result.run.answer?.text).toBe("Simulation finished");
      expect(result.outcome).toBe("succeeded");
    },
    90_000,
  );

  it(
    "while it is still in flight, requestMade matches the request once SENT: a premature `blocked` ends as the met goal",
    async () => {
      holdMs = null;
      // A goal without "finish by reporting": #286 never turns a report goal's `blocked` into "already met".
      const result = await run([{ op: "click", target: "0" }, { op: "blocked" }], undefined, false, {
        goal: "Pressure-test the bet by running the simulation.",
      });
      expect(rpcs).toBe(1);
      expect(result.checks[0]).toMatchObject({ passed: true });
      expect(result.checks[0]?.detail).toContain("sent and still awaiting a response");
      expect(result.outcome).toBe("succeeded");
    },
    90_000,
  );

  it(
    "the report goal, still in flight: requestMade matches the SENT request and the grounded report of the running job meets it",
    async () => {
      holdMs = null;
      const result = await run([{ op: "click", target: "0" }, { op: "report" }], undefined, false, { state: "Simulation running" });
      expect(rpcs).toBe(1);
      expect(result.checks[0]).toMatchObject({ passed: true });
      expect(result.checks[0]?.detail).toContain("sent and still awaiting a response");
      expect(result.run.answer?.text).toBe("Simulation running");
      expect(result.outcome).toBe("succeeded");
    },
    90_000,
  );

  it(
    "while the checks cannot hold yet, `blocked` is deferred into a bounded wait on the in-flight write",
    async () => {
      holdMs = null;
      const result = await run([{ op: "click", target: "0" }, { op: "blocked" }], 1_500, true);
      expect(rpcs).toBe(1);
      expect(notes(result).some((n) => n.startsWith(`blocked deferred: POST ${RPC} (sent by an earlier click) is still in flight`))).toBe(true);
      // Past the job-wait budget the model's `blocked` stands — bounded, never an endless wait.
      expect(result.outcome).toBe("blocked");
      expect(result.checks.find((c) => c.check.startsWith("requestMade"))).toMatchObject({ passed: true });
    },
    90_000,
  );
});
