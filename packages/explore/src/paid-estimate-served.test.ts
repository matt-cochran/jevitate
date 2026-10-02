import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeGenerationGateway } from "@jevitate/ai-core";
import { BrowseTheWeb, CastActor } from "@jevitate/screenplay";
import { validateInvariantSpec } from "@jevitate/recording";
import { runGoalBasedMission } from "./missions/goal-based.js";
import { ScriptedJudge, withSession, useSkippingTime } from "./testkit.js";

// #304: Node and page time skip idle waits (settle windows, hang ceilings, polls); assertions unchanged.
useSkippingTime({ per: "all" });

/**
 * #280 + #279 on a served page whose paid control carries a LIVE estimate range in its name:
 * "Confirm and draft the page (≈ 50–90 credits)". With `--paid '/^(Confirm analysis|Confirm and )/i'`
 * a goal that asks to draft a page asks for it (#280: its action word, never its estimate), and the
 * budget guard reads the range at its HIGH end (#279): 90 crosses the 80-credit budget, 50 would not.
 */
const PAGE = `<!doctype html><html><body>
<p>Credits: <span data-testid="credits">1000</span></p>
<button type="button" id="draft">Confirm and draft the page (≈ 50–90 credits)</button>
<p id="out"></p>
<script>
  document.getElementById("draft").onclick = () => {
    document.querySelector("[data-testid=credits]").textContent = "910";
    document.getElementById("out").textContent = "Draft ready";
  };
</script>
</body></html>`;

let server: Server;
let origin: string;
beforeAll(async () => {
  server = createServer((_req, res) => res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(PAGE));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("a paid control with a live estimate range (#280, #279)", () => {
  it(
    "is asked for by the goal's action word, and the budget guard refuses it at the range's high end",
    async () => {
      const result = await withSession(
        "paid-estimate-",
        async (session) => {
          const actor = CastActor.named("paid").whoCan(new BrowseTheWeb(session, [origin]));
          return runGoalBasedMission({
            actor,
            judge: new ScriptedJudge([{ op: "click", target: "0" }, { op: "done" }]),
            gen: new FakeGenerationGateway(),
            goal: "Draft a landing page about otters",
            allowlist: [origin],
            startUrl: `${origin}/`,
            successAssertion: { kind: "textIncludes", target: { css: "#out" }, text: "Draft ready" },
            oracleTimeoutMs: 1_000,
            waitOpMs: 300,
            bounds: { maxDecisions: 4 },
            safety: { paid: ["/^(Confirm analysis|Confirm and )/i"] },
            invariants: validateInvariantSpec(
              {
                observe: {
                  credits: { dom: { selector: "[data-testid=credits]", number: true } },
                  estimate: { dom: { selector: "#draft", number: true } },
                },
                invariants: [],
                budget: [{ observe: "credits", maxDelta: -80, guard: { estimate: "estimate" } }],
              },
              { allowlist: [origin], baseUrl: `${origin}/` },
            ),
          });
        },
        origin,
      );

      // #280: never refused by the safety policy as "not asked for".
      expect(result.transcript.some((e) => /refused by the safety policy/.test(e.reason ?? ""))).toBe(false);
      // #279: the guard read 90 (the high end), not 50.
      expect(result.run.stop).toBe("budget");
      expect(result.reason).toMatch(/≈90\b/);
      expect(result.budget?.[0]?.refused?.estimate).toBe(90);
      expect(result.outcome).not.toBe("succeeded");
    },
    90_000,
  );
});
