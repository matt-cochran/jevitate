import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { GenerationPort } from "@jevitate/ai-core";
import { BrowseTheWeb, CastActor } from "@jevitate/screenplay";
import { runGoalBasedMission } from "./missions/goal-based.js";
import { ScriptedJudge, withSession, useSkippingTime } from "./testkit.js";

// #304: Node and page time skip idle waits (settle windows, hang ceilings, polls); assertions unchanged.
useSkippingTime({ per: "all" });

/**
 * #338 regression fixture — an app with a sidebar of sections; the goal names one (Answers). The
 * generator first proposes the goal's own instruction as the answer: it is refused (the model sees
 * why) and the run goes on to type a real answer and test it. Once in Answers, the sidebar's other
 * sections are marked off-goal in the decision state.
 */

const PAGE = `<!doctype html><html><head><title>Assistant</title></head><body>
<nav>
  <a href="#home">Home</a> <a href="#answers">Answers</a> <a href="#texting">Texting registration</a> <a href="#team">Team</a>
</nav>
<main>
  <section id="answers" hidden>
    <h1>Answers</h1>
    <label for="answer">Answer</label> <textarea id="answer"></textarea>
    <button id="test" onclick="result.textContent = 'Tested: ' + answer.value; result.hidden = false">Test answer</button>
    <p id="result" data-testid="result" hidden></p>
  </section>
</main>
<script>
  const show = () => { document.getElementById("answers").hidden = location.hash !== "#answers"; };
  addEventListener("hashchange", show); show();
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
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("goal mission — goal focus (#338)", () => {
  it(
    "the goal's instruction typed as a value is refused with its reason in history; the run goes on and succeeds",
    async () => {
      const values = ["Test it with a sample question", "Refunds take five business days."];
      let calls = 0;
      const gen: GenerationPort = {
        generate: async () => ({ output: { text: values[Math.min(calls++, values.length - 1)]! } }) as never,
      };
      // Controls: [0] Home, [1] Answers, [2] Texting registration, [3] Team — then, in Answers,
      // [4] Answer, [5] Test answer.
      const judge = new ScriptedJudge([
        { op: "click", target: "1" },
        { op: "type", target: "4" },
        { op: "type", target: "4" },
        { op: "click", target: "5" },
        { op: "done" },
      ]);
      const result = await withSession(
        "goal-focus-",
        async (session) =>
          runGoalBasedMission({
            actor: CastActor.named("author").whoCan(new BrowseTheWeb(session, [origin])),
            judge,
            gen,
            goal: "Open Answers, add an answer and test it with a sample question.",
            allowlist: [origin],
            startUrl: `${origin}/`,
            successChecks: [{ kind: "page", assertion: { kind: "textIncludes", target: { testId: "result" }, text: "Tested: Refunds" } }],
            oracleTimeoutMs: 500,
          }),
        origin,
      );

      expect(result.outcome).toBe("succeeded");
      const refused = result.transcript.find((e) => e.reason?.includes("goal's instruction"));
      expect(refused?.actOk).toBe(false);
      expect(refused?.origin).toBe("engine");
      expect(refused?.reason).toMatch(/that is the goal's instruction, not a value to enter/);
      const fills = result.recording.pages.flatMap((p) => p.steps.map((s) => s.step)).filter((s) => s.kind === "fill");
      expect(fills.map((s) => (s.kind === "fill" ? s.value : null))).toEqual([{ redacted: false, value: "Refunds take five business days." }]);
      // The model saw the refusal before its next decision.
      expect(judge.states[2]!.history.some((h) => h.includes("goal's instruction"))).toBe(true);
      // Before Answers was opened nothing was off-goal; inside it, the unnamed sections are.
      expect(JSON.stringify(judge.states[0])).not.toMatch(/off-goal/);
      const inside = judge.states[1]!.controls;
      expect(inside.find((l) => l.includes("Texting registration"))).toMatch(/off-goal/);
      expect(inside.find((l) => l.includes('"Answers"'))).not.toMatch(/off-goal/);
      expect(inside.find((l) => l.includes('"Test answer"'))).not.toMatch(/off-goal/);
    },
    120_000,
  );
});
