import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeGenerationGateway } from "@jevitate/ai-core";
import { BrowseTheWeb, CastActor } from "@jevitate/screenplay";
import { runGoalBasedMission, type GoalBasedResult } from "./missions/goal-based.js";
import { PreferenceJudge, withSession, useSkippingTime } from "./testkit.js";

// #304: Node and page time skip idle waits (settle windows, polls); assertions unchanged.
useSkippingTime({ per: "all" });

/**
 * #446 — inline validation text that becomes visible after submit (no role=alert, no aria-invalid)
 * is not status text, and it is not a control: the run clicked Create until no-progress and ended
 * with a bare "no progress". Newly visible text in the acted-on form is told to the model as the
 * form's message, kept in its prompt while it shows, and named as the outcome when the run cannot
 * get past it.
 */

const HTML = `<!doctype html><html><body><main><h1>New site</h1>
<form id="f"><label>Domain <input name="d"></label><p class="err" hidden>Domain cannot contain spaces</p><button>Create</button></form>
<script>
  document.getElementById("f").addEventListener("submit", (e) => {
    e.preventDefault();
    const v = e.target.d.value;
    if (/\\s/.test(v)) document.querySelector(".err").hidden = false;
    else document.querySelector("main").innerHTML = "<h1>Created " + v + "</h1>";
  });
</script>
</main></body></html>`;

let server: Server;
let origin: string;
beforeAll(async () => {
  server = createServer((_req, res) => res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(HTML));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** A model that types "a b" into Domain, then clicks Create every turn. */
async function submitWithSpace(actionDeltas: boolean): Promise<{ result: GoalBasedResult; judge: PreferenceJudge }> {
  const judge = new PreferenceJudge((n) => (n === 0 ? [{ op: "type", name: /Domain/ }] : [{ op: "click", name: "Create" }]), "done");
  const result = await withSession(
    "form-message-",
    async (session) => {
      const actor = CastActor.named("owner").whoCan(new BrowseTheWeb(session, [origin]));
      return runGoalBasedMission({
        actor,
        judge,
        gen: new FakeGenerationGateway({ "form.value": { text: "a b" } }),
        goal: "create a site with domain 'a b'",
        allowlist: [origin],
        startUrl: `${origin}/`,
        waitOpMs: 300,
        bounds: { maxDecisions: 14 },
        actionDeltas,
      });
    },
    origin,
  );
  return { result, judge };
}

describe("#446 — newly visible validation text in the acted-on form", () => {
  it(
    "is told to the model as the form's message after the click that revealed it",
    async () => {
      const { judge } = await submitWithSpace(false);
      const history = judge.states[2]?.history ?? [];
      expect(history.join("\n")).toContain('after click Create: the form now shows "Domain cannot contain spaces"');
    },
    90_000,
  );

  it(
    "stays in the model's page status while it shows",
    async () => {
      const { judge } = await submitWithSpace(false);
      const status = (judge.states.at(-1)?.controls ?? []).find((l) => l.startsWith("PAGE STATUS")) ?? "";
      expect(status).toContain('form message "Domain cannot contain spaces"');
    },
    90_000,
  );

  it(
    "is the outcome reason when the run cannot get past it",
    async () => {
      const { result } = await submitWithSpace(false);
      expect(result.run.outcome.status === "incomplete" ? result.run.outcome.reason : "").toContain('the form shows "Domain cannot contain spaces"');
    },
    90_000,
  );

  it(
    "is the outcome reason with action deltas on too",
    async () => {
      const { result } = await submitWithSpace(true);
      expect(result.run.outcome.status === "incomplete" ? result.run.outcome.reason : "").toContain('the form shows "Domain cannot contain spaces"');
    },
    90_000,
  );
});
