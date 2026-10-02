import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeGenerationGateway } from "@jevitate/ai-core";
import { BrowseTheWeb, CastActor } from "@jevitate/screenplay";
import { runGoalBasedMission, type GoalBasedResult } from "./goal-based.js";
import { PreferenceJudge, withSession, useSkippingTime } from "../testkit.js";

// #304: Node and page time skip idle waits (settle windows, hang ceilings, polls); assertions unchanged.
useSkippingTime({ per: "all" });

/**
 * #287 — on an editor page with ~150 controls the control list stopped at the cap, and the
 * `<summary>` "Analysis & diagnostics" (holding the evidence panel) never reached the model: asked
 * to expand it, the run reported done three times without it. A disclosure summary is a control, and
 * a control the goal names is offered even past the cap.
 */

const buttons = Array.from({ length: 150 }, (_, i) => `<button>Block ${i + 1}</button>`).join("\n");
const HTML = `<!doctype html><html><body>
<h1>Editor</h1>
${buttons}
<details><summary>Analysis &amp; diagnostics</summary><section><h2>Evidence panel</h2><p>3 sources support the claim.</p></section></details>
</body></html>`;

let server: Server;
let origin: string;
beforeAll(async () => {
  server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(HTML);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function run(): Promise<{ result: GoalBasedResult; judge: PreferenceJudge }> {
  // Expands the disclosure once, then proposes done.
  const judge = new PreferenceJudge((_n, s) => (s.history.some((h) => /clicked Analysis/.test(h)) ? [] : [{ op: "click", name: "Analysis & diagnostics" }]), "done");
  const result = await withSession(
    "disclosure-cap-",
    async (session) => {
      const actor = CastActor.named("editor").whoCan(new BrowseTheWeb(session, [origin]));
      return runGoalBasedMission({
        actor,
        judge,
        gen: new FakeGenerationGateway(),
        goal: "Expand Analysis & diagnostics and look at the evidence panel.",
        allowlist: [origin],
        startUrl: `${origin}/editor`,
        waitOpMs: 300,
        bounds: { maxDecisions: 6, maxCandidates: 100 },
      });
    },
    origin,
  );
  return { result, judge };
}

describe("#287 — a disclosure the goal names is never crowded out by the control cap", () => {
  it(
    "the summary past the 100-control cap is offered, clicked, and its state shown as expanded",
    async () => {
      const { result, judge } = await run();
      expect(judge.calls[0]!.state.controls.some((l) => /button "Analysis & diagnostics" \(collapsed\)/.test(l))).toBe(true);
      const click = result.transcript.find((e) => e.op === "click");
      expect(click?.actOk).toBe(true);
      expect(click?.target).toContain('"Analysis & diagnostics"');
      expect(judge.calls[1]!.state.controls.some((l) => /button "Analysis & diagnostics" \(expanded\)/.test(l))).toBe(true);
      expect(result.run.stop).toBe("done");
    },
    120_000,
  );
});
