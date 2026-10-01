import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeGenerationGateway } from "@jevitate/ai-core";
import { BrowseTheWeb, CastActor } from "@jevitate/screenplay";
import { runGoalBasedMission, type GoalBasedResult } from "./goal-based.js";
import { PreferenceJudge, withSession, type Preference } from "../testkit.js";

/**
 * #294 — a closed slide-in panel kept mounted and moved off-screen with a CSS transform: its
 * controls were offered on every step, the model typed into the invisible field and clicked the
 * off-screen Save until no-progress, and never touched the visible page.
 *
 *  - a control whose box lies wholly outside the area the page can scroll to is not offered;
 *  - a click that keeps timing out on the same target is reported "not reachable" and the target
 *    is withheld, so the model moves on.
 */

const PANEL = `<!doctype html><html><body>
<a href="/help">Help</a>
<button id="create">Create</button>
<p id="out"></p>
<aside style="position:fixed;right:0;top:0;width:320px;height:100vh;transform:translateX(100%)">
  <label>Name * <input id="name"></label><button id="save">Save Changes</button>
</aside>
<script>
  document.getElementById("create").addEventListener("click", () => {
    document.getElementById("out").textContent = "Item created";
    document.getElementById("create").remove();
  });
</script>
</body></html>`;

/** A target that is on screen but never stops moving: every click times out. */
const RESTLESS = `<!doctype html><html><head><style>
@keyframes jiggle { from { transform: translateX(0) } to { transform: translateX(40px) } }
#save { animation: jiggle 0.15s infinite alternate linear; }
</style></head><body>
<div><button id="save">Save Changes</button></div>
<p><a href="/help">Help</a></p>
<div><button id="create">Create</button></div>
<p id="out"></p>
<script>
  document.getElementById("create").addEventListener("click", () => {
    document.getElementById("out").textContent = "Item created";
    document.getElementById("create").remove();
  });
</script>
</body></html>`;

let server: Server;
let origin: string;
beforeAll(async () => {
  server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(req.url === "/restless" ? RESTLESS : PANEL);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function run(path: string, prefs: readonly Preference[]): Promise<{ result: GoalBasedResult; judge: PreferenceJudge }> {
  const judge = new PreferenceJudge(prefs, "done");
  const result = await withSession(
    "offscreen-",
    async (session) => {
      const actor = CastActor.named("owner").whoCan(new BrowseTheWeb(session, [origin]));
      return runGoalBasedMission({
        actor,
        judge,
        gen: new FakeGenerationGateway(),
        goal: "Create an item.",
        allowlist: [origin],
        startUrl: `${origin}${path}`,
        waitOpMs: 300,
        bounds: { maxDecisions: 15 },
      });
    },
    origin,
  );
  return { result, judge };
}

const SAVE_FIRST: Preference[] = [
  { op: "type", name: "Name *" },
  { op: "click", name: "Save Changes" },
  { op: "click", name: "Create" },
];
const touched = (r: GoalBasedResult, name: string): number => r.transcript.filter((e) => (e.target ?? "").includes(`"${name}"`)).length;

describe("#294 — controls the page can never bring into view", () => {
  it(
    "a closed panel translated off-screen offers none of its controls: the model acts on the visible page",
    async () => {
      const { result, judge } = await run("/panel", SAVE_FIRST);
      expect(judge.calls.every((c) => !c.state.controls.some((l) => /Save Changes|Name \*/.test(l)))).toBe(true);
      expect(touched(result, "Save Changes")).toBe(0);
      expect(touched(result, "Name *")).toBe(0);
      expect(result.transcript.some((e) => e.op === "click" && e.actOk && (e.target ?? "").includes('"Create"'))).toBe(true);
      expect(result.run.stop).toBe("done");
    },
    90_000,
  );

  it(
    "a click that times out twice on the same target is reported not reachable and withheld; the model moves on",
    async () => {
      const { result, judge } = await run("/restless", [{ op: "click", name: "Save Changes" }, { op: "click", name: "Create" }]);
      // Two timeouts on Save Changes, then it is withheld and the model's next choice is Create.
      const [a, b, c] = result.transcript;
      expect([a, b].every((e) => e?.op === "click" && !e.actOk && (e.target ?? "").includes('"Save Changes"'))).toBe(true);
      expect(c?.op === "click" && c.actOk && (c.target ?? "").includes('"Create"')).toBe(true);
      expect(judge.states.some((s) => s.history.some((h) => /"Save Changes" failed 2 times: it is not reachable/.test(h)))).toBe(true);
      expect(result.run.stop).toBe("done");
    },
    90_000,
  );
});
