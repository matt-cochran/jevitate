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
 * #273 — the goal loop kept issuing `select` with the option that was ALREADY selected (the `—`
 * placeholder, whose value is not empty), so the control never changed and the run ended
 * no-progress. A select of the current option is a no-op: it is never acted, the model is told the
 * options it has not tried, and a placeholder is never chosen unless the goal asks to clear it.
 * Options with en dashes / `$` survive the generated value → option mapping.
 */

const HTML = `<!doctype html><html><body>
<h1>New decision</h1>
<label>Dollars at risk · your estimate
  <select id="risk">
    <option value="0" selected>—</option>
    <option value="1">Under $10k</option>
    <option value="2">$10k–$100k</option>
    <option value="3">Over $100k</option>
  </select>
</label>
<p id="preview">Rigor preview: not set</p>
<script>
  const s = document.getElementById("risk");
  s.addEventListener("change", () => {
    document.getElementById("preview").textContent = "Rigor preview: " + s.options[s.selectedIndex].text;
  });
</script>
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

const GOAL = "You want to know what checking a ~$50k bet would cost. Set the dollars at risk.";

async function run(gen: FakeGenerationGateway, selects = 1): Promise<{ result: GoalBasedResult; judge: PreferenceJudge }> {
  // Selects the field `selects` times, then proposes done.
  const judge = new PreferenceJudge((n) => (n < selects ? [{ op: "select", name: "Dollars at risk · your estimate" }] : []), "done");
  const result = await withSession(
    "select-noop-",
    async (session) => {
      const actor = CastActor.named("owner").whoCan(new BrowseTheWeb(session, [origin]));
      return runGoalBasedMission({
        actor,
        judge,
        gen,
        goal: GOAL,
        allowlist: [origin],
        startUrl: `${origin}/decisions/new`,
        waitOpMs: 300,
        bounds: { maxDecisions: 12 },
      });
    },
    origin,
  );
  return { result, judge };
}

const selects = (r: GoalBasedResult) => r.transcript.filter((e) => e.op === "select");

describe("#273 — select never re-chooses the current option or a placeholder", () => {
  it(
    "the value generator is never offered the selected placeholder: the field actually changes",
    async () => {
      // The fake generator answers with the FIRST option it is offered.
      const { result } = await run(new FakeGenerationGateway());
      const done = selects(result).filter((e) => e.actOk);
      expect(done).toHaveLength(1);
      expect(done[0]!.value).toBe("Under $10k");
      expect(result.run.stop).toBe("done");
    },
    90_000,
  );

  it(
    "a generated value spelled with a hyphen still maps onto the en-dash option",
    async () => {
      const { result } = await run(new FakeGenerationGateway({ "form.value": { text: "$10k-$100k" } }));
      const done = selects(result).filter((e) => e.actOk);
      expect(done).toHaveLength(1);
      expect(done[0]!.value).toBe("$10k–$100k");
    },
    90_000,
  );

  it(
    "choosing the option already selected is refused before acting, naming the options not tried",
    async () => {
      // First select → $10k–$100k; the second asks for the same option again.
      const { result, judge } = await run(new FakeGenerationGateway({ "form.value": { text: "$10k–$100k" } }), 2);
      const s = selects(result);
      expect(s.filter((e) => e.actOk)).toHaveLength(1);
      const refused = s.filter((e) => !e.actOk);
      expect(refused).toHaveLength(1);
      expect(refused[0]!.origin).toBe("engine");
      expect(refused[0]!.reason).toMatch(/already selected/);
      const told = judge.states.flatMap((st) => st.history).find((h) => /already selected/.test(h)) ?? "";
      expect(told).toContain('"Under $10k"');
      expect(told).toContain('"Over $100k"');
      expect(told).not.toContain('"—"');
    },
    90_000,
  );
});
