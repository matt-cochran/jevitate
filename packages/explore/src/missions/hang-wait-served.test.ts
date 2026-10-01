import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeGenerationGateway } from "@jevitate/ai-core";
import { BrowseTheWeb, CastActor } from "@jevitate/screenplay";
import { runGoalBasedMission } from "./goal-based.js";
import { ScriptedJudge, withSession } from "../testkit.js";

/**
 * Waits that are the app WORKING, not hung — and the frozen UIs that must still be hangs:
 *
 *  - #289: "Save changes" writes (200) and returns to the hub it came from — progress, not a page
 *          that "returned to an earlier state". The same return after a REJECTED write stays a hang.
 */

const html = (body: string): string => `<!doctype html><html><body>${body}</body></html>`;
let server: Server;
let origin: string;

/** Project settings: "Save changes" writes, then the app returns to the project hub (as designed). */
const settingsPage = (endpoint: string): string =>
  html(`<h1>Project settings</h1><label>Name <input name="name" value="Alpha"></label>
    <button type="button" id="save">Save changes</button><script>
    document.getElementById("save").onclick = () =>
      fetch("${endpoint}", { method: "POST", body: "{}" }).then(() => { location.href = "/hub"; });
  </script>`);

beforeAll(async () => {
  server = createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0] ?? "";
    const page = (body: string): void => void res.writeHead(200, { "content-type": "text/html" }).end(body);
    switch (path) {
      case "/hub":
        return page(html(`<h1>Alpha hub</h1><a href="/settings">Settings</a><a href="/settings-broken">Settings (broken)</a>`));
      case "/settings":
        return page(settingsPage("/api/save"));
      case "/settings-broken":
        return page(settingsPage("/api/save-broken"));
      case "/api/save":
        return void res.writeHead(200, { "content-type": "application/json" }).end("{}");
      case "/api/save-broken":
        return void res.writeHead(500, { "content-type": "application/json" }).end("{}");
      default:
        return void res.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (addr === null || typeof addr === "string") throw new Error("no port");
  origin = `http://127.0.0.1:${(addr satisfies AddressInfo).port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const FAST = { renderWaitMs: 4_000, requestBoundMs: 3_000, hangProbeMs: 2_000 };

describe("#289 — save-and-return navigation is progress, not a hang", () => {
  const saveAndReturn = (settingsLink: string) =>
    withSession(
      "hang-wait-save-",
      async (session) => {
        const actor = CastActor.named("save").whoCan(new BrowseTheWeb(session, [origin]));
        return runGoalBasedMission({
          actor,
          judge: new ScriptedJudge([
            { op: "click", target: settingsLink }, // hub → settings (new)
            { op: "click", target: "1" }, // Save changes → back to the hub (visited earlier)
            { op: "scroll_down" },
            { op: "scroll_down" },
          ]),
          gen: new FakeGenerationGateway(),
          goal: "rename the project",
          allowlist: [origin],
          startUrl: `${origin}/hub`,
          successAssertion: { kind: "visible", target: { text: "Renamed" } },
          stallMs: 300,
          oracleTimeoutMs: 100,
          ...FAST,
        });
      },
      origin,
    );

  it("Save changes (200) returning to the hub is not a ui-no-progress hang", async () => {
    const r = await saveAndReturn("0");
    expect(r.transcript.some((e) => e.target?.includes("Save changes") && e.actOk)).toBe(true);
    expect(r.hang).toBeUndefined();
    expect(r.run.stop).not.toBe("hang");
  }, 90_000);

  it("the same return after a REJECTED save (500) is still a ui-no-progress hang", async () => {
    const r = await saveAndReturn("1");
    expect(r.run.stop).toBe("hang");
    expect(r.hang?.hangKind).toBe("ui-no-progress");
    expect(r.hang?.signal.detail).toMatch(/returned to an earlier state/);
  }, 90_000);
});
