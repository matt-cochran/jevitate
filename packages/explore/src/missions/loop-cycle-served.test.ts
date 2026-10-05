import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeGenerationGateway } from "@jevitate/ai-core";
import { BrowseTheWeb, CastActor } from "@jevitate/screenplay";
import { runGoalBasedMission, type GoalBasedResult } from "./goal-based.js";
import { ScriptedJudge, withSession, type ScriptedStep, useSkippingTime } from "../testkit.js";

// #304: Node and page time skip idle waits; assertions unchanged.
useSkippingTime({ per: "all" });

/**
 * #367 — a goal run that alternates between two controls (or scrolls up and down) with no request
 * and nothing new on the page stops as no-progress, naming the loop, well before its budget. And
 * #371 — the no-progress reason names the LATEST failed action, not a stale blocker from early on.
 * Static pages from the issues' minimal repros; scripted judges only.
 */
const PAGES: Record<string, string> = {
  // Two static pages linked to each other; the goal names a control neither has.
  "/a": `<!doctype html><html><body><h1>Home</h1><p>Welcome.</p><a href="/b">Show site</a></body></html>`,
  "/b": `<!doctype html><html><body><h1>Site preview</h1><p>Your site.</p><a href="/a">Back</a></body></html>`,
  // A disclosure toggled open and shut.
  "/disclosure": `<!doctype html><html><body><h1>Settings</h1>
    <button type="button" aria-expanded="false" id="t">More options ▾</button>
    <div id="more" hidden><p>Colour: blue</p></div>
    <script>
      const t = document.getElementById("t"), more = document.getElementById("more");
      t.addEventListener("click", () => {
        const open = more.hidden;
        more.hidden = !open;
        t.setAttribute("aria-expanded", String(open));
        t.textContent = open ? "More options ▴" : "More options ▾";
      });
    </script></body></html>`,
  // A page a little taller than the viewport, without the target: scrolls only flip between its ends.
  "/short": `<!doctype html><html><body style="margin:0"><h1>About</h1><p>Nothing to publish here.</p>
    <div style="height:1100px"></div><a href="/a">Home</a></body></html>`,
  // #371: a disabled hint button met first, then a field whose every generated value is rejected.
  "/blocker": `<!doctype html><html><body><h1>Your shop</h1>
    <button type="button" disabled>Tap the map to drop a pin</button>
    <form onsubmit="event.preventDefault()"><label>Shop description <input type="text" name="d" /></label><button>Save</button></form>
    </body></html>`,
};

let server: Server;
let origin: string;
beforeAll(async () => {
  server = createServer((req, res) => {
    const page = PAGES[(req.url ?? "/").split("?")[0]!];
    if (page === undefined) res.writeHead(404).end();
    else res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(page);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function run(path: string, steps: ScriptedStep[], goal: string, gen = new FakeGenerationGateway({})): Promise<GoalBasedResult> {
  return withSession(
    "loop-cycle-",
    async (session) =>
      runGoalBasedMission({
        actor: CastActor.named("looper").whoCan(new BrowseTheWeb(session, [origin])),
        judge: new ScriptedJudge(steps),
        gen,
        goal,
        allowlist: [origin],
        startUrl: `${origin}${path}`,
        successChecks: [{ kind: "page", assertion: { kind: "visible", target: { text: "Published" } } }],
        bounds: { maxDecisions: 60 },
        oracleTimeoutMs: 300,
        waitOpMs: 300,
      }),
    origin,
  );
}

const reasonOf = (r: GoalBasedResult): string => (r.run.outcome.status === "incomplete" ? r.run.outcome.reason : "");

describe("#367 — a loop over two controls is no progress", () => {
  it("clicking between two static pages linked to each other stops as no-progress naming the loop", async () => {
    const result = await run("/a", Array.from({ length: 60 }, () => ({ op: "click", target: "0" }) as ScriptedStep), "Click the Publish button");
    const clicks = result.transcript.filter((e) => e.op === "click").length;
    expect(result.run.stop).toBe("no-progress");
    expect(reasonOf(result)).toMatch(/^no progress: the run went round a loop — click "Show site" ↔ click "Back" — 4 times/);
    expect(clicks).toBeLessThanOrEqual(10);
    expect(result.run.decisions).toBeLessThan(60);
  }, 120_000);

  it("a disclosure toggled open and shut stops as no-progress", async () => {
    const result = await run("/disclosure", Array.from({ length: 60 }, () => ({ op: "click", target: "0" }) as ScriptedStep), "Turn on dark mode");
    const clicks = result.transcript.filter((e) => e.op === "click").length;
    expect(result.run.stop).toBe("no-progress");
    expect(reasonOf(result)).toContain("the run went round a loop");
    expect(reasonOf(result)).toContain('click "More options');
    expect(clicks).toBeLessThanOrEqual(10);
  }, 120_000);

  it("scrolling down and up on a page without the target (it barely moves) stops as no-progress", async () => {
    const pattern: ScriptedStep[] = [{ op: "scroll_down" }, { op: "scroll_down" }, { op: "scroll_up" }, { op: "scroll_up" }];
    const result = await run("/short", Array.from({ length: 60 }, (_, i) => pattern[i % pattern.length]!), "Click the Publish button");
    const scrolls = result.transcript.filter((e) => e.op === "scroll_down" || e.op === "scroll_up").length;
    expect(result.run.stop).toBe("no-progress");
    expect(reasonOf(result)).toMatch(/no progress/);
    expect(scrolls).toBeLessThanOrEqual(12);
  }, 120_000);
});

describe("#371 — the no-progress reason names the latest blocker", () => {
  it("a disabled hint met first does not stand in for the rejected types that followed", async () => {
    // Controls: [0] Tap the map… (disabled), [1] Shop description, [2] Save.
    const steps: ScriptedStep[] = [{ op: "click", target: "0" }, ...Array.from({ length: 30 }, () => ({ op: "type", target: "1" }) as ScriptedStep)];
    const gen = new FakeGenerationGateway({ "form.value": { text: "Shop description: classic cuts" } });
    const result = await run("/blocker", steps, "Describe the barber shop and save it", gen);
    expect(result.transcript[0]?.reason).toContain("Tap the map to drop a pin");
    expect(result.transcript.at(-1)?.reason).toMatch(/^typed value rejected: echoes the field's label/);
    expect(result.run.stop).toBe("no-progress");
    expect(result.run.blockingCause).toMatch(/^type "Shop description" rejected: echoes the field's label/);
    expect(reasonOf(result)).toContain('last blocker: type "Shop description" rejected: echoes the field\'s label');
    expect(reasonOf(result)).not.toContain("Tap the map");
  }, 120_000);
});
