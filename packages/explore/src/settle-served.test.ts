import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeGenerationGateway } from "@jevitate/ai-core";
import { BrowseTheWeb, CastActor } from "@jevitate/screenplay";
import { monitorFor } from "./page-monitor.js";
import { perceive } from "./perceive.js";
import { runGoalBasedMission } from "./missions/goal-based.js";
import { ScriptedJudge, withSession } from "./testkit.js";

/**
 * Live-updating and long-lived apps are NOT hung (owner follow-up to rulings 4/7): an SSE stream, a
 * ticking clock, a long-poll on an interactive page and a declared background poller all settle,
 * and none of them is a hang. A stuck request on a page that cannot be used still is (hang tests).
 */

const open: ServerResponse[] = [];
const timers: ReturnType<typeof setInterval>[] = [];
const html = (body: string): string => `<!doctype html><html><body>${body}</body></html>`;

let server: Server;
let origin: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0] ?? "";
    switch (path) {
      case "/sse": {
        // An endless SSE stream: an event every 200ms, forever.
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        open.push(res);
        let n = 0;
        timers.push(setInterval(() => res.write(`data: ${n++}\n\n`), 200));
        return;
      }
      case "/never":
      case "/api/background/poll":
        open.push(res); // never answered
        return;
      case "/sse-page":
        res.writeHead(200, { "content-type": "text/html" }).end(
          html(`<button type="button">Pause</button><p id="n">0</p><script>
            // EventSource AND SSE over fetch — both long-lived, neither is pending work.
            new EventSource("/sse").onmessage = (e) => { document.getElementById("n").textContent = e.data; };
            fetch("/sse").then((r) => r.body.getReader().read());
          </script>`),
        );
        return;
      case "/clock":
        res.writeHead(200, { "content-type": "text/html" }).end(
          html(`<button type="button">Start</button><span id="t"></span><script>
            // A live clock: its text changes every 100ms, forever (text-only mutations).
            setInterval(() => { document.getElementById("t").textContent = new Date().toISOString(); }, 100);
          </script>`),
        );
        return;
      case "/long-poll":
        res.writeHead(200, { "content-type": "text/html" }).end(
          html(`<button type="button">Send</button><script>fetch("/never");</script>`),
        );
        return;
      case "/background":
        res.writeHead(200, { "content-type": "text/html" }).end(
          html(`<button type="button">Send</button><script>fetch("/api/background/poll");</script>`),
        );
        return;
      case "/wizard":
        // Next → a NEW step 2 → Back → step 1 again. Returning to an earlier state after a new one
        // appeared is progress, not a hang.
        res.writeHead(200, { "content-type": "text/html" }).end(
          html(`<div id="root"></div><script>
            const root = document.getElementById("root");
            const show = (label, next) => { root.innerHTML = ""; const b = document.createElement("button"); b.type = "button"; b.textContent = label; b.onclick = next; root.appendChild(b); };
            const one = () => show("Next", () => show("Back", one));
            one();
          </script>`),
        );
        return;
      case "/import":
        res.writeHead(200, { "content-type": "text/html" }).end(
          html(`<div id="root"></div><script>
            const root = document.getElementById("root");
            const show = (label, next) => { root.innerHTML = ""; const b = document.createElement("button"); b.type = "button"; b.textContent = label; b.onclick = next; root.appendChild(b); };
            const start = () => show("Process & Import", () => show("Confirm & Continue", start));
            start();
          </script>`),
        );
        return;
      default:
        res.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (addr === null || typeof addr === "string") throw new Error("no port");
  origin = `http://127.0.0.1:${(addr satisfies AddressInfo).port}`;
});
afterAll(async () => {
  for (const t of timers) clearInterval(t);
  for (const r of open) r.destroy();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** Bounds small enough that "would have hit the ceiling" shows up fast. */
const BOUNDS = { renderWaitMs: 4_000, requestBoundMs: 3_000, hangProbeMs: 1_000 };

async function look(path: string, extra: Parameters<typeof perceive>[1] = {}) {
  return withSession(
    "settle-served-",
    async (session) => {
      await monitorFor(session.page).instrument();
      await session.page.goto(`${origin}${path}`, { waitUntil: "domcontentloaded" });
      return perceive(session.page, { ...BOUNDS, ...extra });
    },
    origin,
  );
}

describe("long-lived and live-updating pages settle and are not hangs", () => {
  it("an SSE page (EventSource + text/event-stream over fetch) settles", async () => {
    const p = await look("/sse-page");
    expect(p.settle.settled).toBe(true);
    expect(p.settle.waitedMs).toBeLessThan(2_000); // recognised as streams, not waited out
    expect(p.hang).toBeNull();
    expect(p.settle.background?.map((b) => b.why).sort()).toEqual(["stream", "stream"]);
  });

  it("a ticking-clock page settles: text-only updates of existing nodes do not reset the quiet window", async () => {
    const p = await look("/clock");
    expect(p.settle.settled).toBe(true);
    expect(p.settle.waitedMs).toBeLessThan(2_000);
    expect(p.hang).toBeNull();
  });

  it("a request pending past the long-poll threshold on an INTERACTIVE page is a long-poll, not a hang", async () => {
    const p = await look("/long-poll", { settleConfig: { longPollMs: 1_000 } });
    expect(p.settle.settled).toBe(true);
    expect(p.hang).toBeNull();
    expect(p.settle.background).toMatchObject([{ why: "long-poll" }]);
  });

  it("a request the target marks as background (settle.ignoreRequests) never counts", async () => {
    const p = await look("/background", { settleConfig: { ignoreRequests: ["/api/background/*"] } });
    expect(p.settle.settled).toBe(true);
    expect(p.settle.waitedMs).toBeLessThan(1_000); // no long-poll wait needed: declared up front
    expect(p.settle.background).toMatchObject([{ why: "ignored" }]);
  });
});

describe("ui-no-progress needs the action's target state to have NEVER appeared", () => {
  const run = (path: string, steps: ConstructorParameters<typeof ScriptedJudge>[0], hangs?: { ignoreNoProgress: string[] }) =>
    withSession(
      "settle-served-np-",
      async (session) => {
        const actor = CastActor.named("np").whoCan(new BrowseTheWeb(session, [origin]));
        return runGoalBasedMission({
          actor,
          judge: new ScriptedJudge(steps),
          gen: new FakeGenerationGateway(),
          goal: "finish",
          allowlist: [origin],
          startUrl: `${origin}${path}`,
          successAssertion: { kind: "visible", target: { text: "Done" } },
          stallMs: 300,
          oracleTimeoutMs: 100,
          ...BOUNDS,
          ...(hangs === undefined ? {} : { hangs }),
        });
      },
      origin,
    );

  it("Next → a new state → Back to the start is progress: plain no-progress, not a hang", async () => {
    const r = await run("/wizard", [
      { op: "click", target: "0" }, // Next → a NEW state (Back)
      { op: "click", target: "0" }, // Back → the start again
      { op: "scroll_down" },
    ]);
    expect(r.run.stop).toBe("no-progress");
    expect(r.hang).toBeUndefined();
  });

  it("a target that declares the action as expected to return (hangs.ignoreNoProgress) gets no hang", async () => {
    const r = await run(
      "/import",
      [{ op: "click", target: "0" }, { op: "click", target: "0" }, { op: "scroll_down" }],
      { ignoreNoProgress: ["click Confirm*"] },
    );
    expect(r.run.stop).toBe("no-progress");
    expect(r.hang).toBeUndefined();
  });
});
