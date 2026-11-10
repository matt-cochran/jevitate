import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeGenerationGateway } from "@jevitate/ai-core";
import { BrowseTheWeb, CastActor } from "@jevitate/screenplay";
import { runGoalBasedMission, type GoalBasedResult } from "./goal-based.js";
import { PreferenceJudge, withSession, useSkippingTime, type Preference } from "../testkit.js";

// #304: Node and page time skip idle waits; assertions unchanged.
useSkippingTime({ per: "all" });

/**
 * RC3 lab (accuracy j3-deadend J3 r7): a client-side wizard whose last step's Import is disabled.
 * The run went Step 1 → 2 → 3, restarted the wizard from a link, went 1 → 2 → 3 again and then
 * only scrolled. The second "Continue" from Step 2 landed on Step 3 — a state seen before, so the
 * stall rule read it as "the action sent the page back to an earlier state" and declared a
 * `ui-no-progress` hang. It was the same forward step, from the same state, landing where it
 * landed the first time: a dead end, not an action that undid itself.
 */
const wizard = (revert: boolean): string => `<!doctype html><html><body>
<nav><a href="/wizard${revert ? "-revert" : ""}">Start over</a></nav>
<h1>Import contacts</h1>
<section id="s1"><h2>Step 1: choose a file</h2><p>Paste your CSV.</p><button id="c1">Continue</button></section>
<section id="s2" hidden><h2>Step 2: map the columns</h2><select aria-label="Email column"><option>email</option></select><button id="c2">Continue</button></section>
<section id="s3" hidden><h2>Step 3: confirm</h2><p>Contacts found: 2.</p><button disabled>Import</button></section>
<script>
  const show = (id) => { for (const s of ["s1", "s2", "s3"]) document.getElementById(s).hidden = s !== id; };
  document.getElementById("c1").addEventListener("click", () => show("s2"));
  document.getElementById("c2").addEventListener("click", () => show(${revert ? '"s1"' : '"s3"'}));
</script>
</body></html>`;

let server: Server;
let origin: string;
beforeAll(async () => {
  server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(wizard(req.url === "/wizard-revert"));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** Clicks `names` in order, then only scrolls. */
async function runClicks(names: readonly string[], path: string): Promise<GoalBasedResult> {
  const prefs = (n: number): readonly Preference[] => {
    const name = names[n];
    return name === undefined ? [{ op: "scroll_down" }] : [{ op: "click", name }];
  };
  const judge = new PreferenceJudge(prefs, "scroll_down");
  judge.goalMetProbability = 0.1;
  return withSession(
    "repeat-forward-step-",
    async (session) => {
      const actor = CastActor.named("owner").whoCan(new BrowseTheWeb(session, [origin]));
      return runGoalBasedMission({
        actor,
        judge,
        gen: new FakeGenerationGateway(),
        goal: "Import the contacts from the CSV.",
        allowlist: [origin],
        startUrl: `${origin}${path}`,
        waitOpMs: 300,
        stallMs: 1_500,
        bounds: { maxDecisions: 14 },
      });
    },
    origin,
  );
}

describe("a forward step repeated onto the state it reached the first time is not a hang", () => {
  it("Step 1 → 2 → 3, Start over, 1 → 2 → 3 again, then a dead end does not end as a ui-no-progress hang", async () => {
    const result = await runClicks(["Continue", "Continue", "Start over", "Continue", "Continue"], "/wizard");
    expect(result.run.hang).toBeUndefined();
    expect(result.run.stop).not.toBe("hang");
  }, 90_000);

  it("a Continue that drops the wizard back to Step 1 (where the run started) is still a ui-no-progress hang", async () => {
    const result = await runClicks(["Continue", "Continue"], "/wizard-revert");
    expect(result.run.hang?.signal.kind).toBe("ui-no-progress");
    expect(result.run.hang?.signal.detail).toMatch(/^after "click Continue" the page returned to an earlier state/);
  }, 90_000);
});
