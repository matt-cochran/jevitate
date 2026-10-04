import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FakeGenerationGateway } from "@jevitate/ai-core";
import { BrowseTheWeb, CastActor } from "@jevitate/screenplay";
import { runGoalBasedMission } from "./missions/goal-based.js";
import type { SafetyConfig } from "./safety.js";
import { ScriptedJudge, withSession, useSkippingTime } from "./testkit.js";

// #304: Node and page time skip idle waits; assertions unchanged.
useSkippingTime({ per: "all" });

/**
 * #334 — the issue's repro, served for real: a privacy action asks for confirmation with a native
 * `window.confirm`. Playwright dismisses it when nobody listens, so the POST never went out and the
 * run never learned why. Now the run's `dialogs` policy answers it, and every dialog is logged.
 */
const PAGE = `<!doctype html><html><head><title>Consent</title></head><body>
<h1>Showcase</h1>
<button onclick="if (confirm('Revoke consent?')) fetch('/revoke', {method:'POST'}).then(() => done.textContent = 'revoked')">Revoke consent</button>
<button onclick="if (confirm('This will delete all your showcase photos. Continue?')) fetch('/withdraw', {method:'POST'}).then(() => done.textContent = 'withdrawn')">Withdraw</button>
<div id="done" data-testid="done"></div>
</body></html>`;

let server: Server;
let origin: string;
let posts: string[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.method === "POST") {
      posts.push(req.url ?? "");
      res.writeHead(204).end();
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(PAGE);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  posts = [];
});

async function run(goal: string, target: string, path: string, safety: SafetyConfig) {
  // Controls: [0] Revoke consent, [1] Withdraw.
  const judge = new ScriptedJudge([{ op: "click", target }, { op: "done" }]);
  return withSession(
    "native-dialogs-",
    async (session) =>
      runGoalBasedMission({
        actor: CastActor.named("owner").whoCan(new BrowseTheWeb(session, [origin])),
        judge,
        gen: new FakeGenerationGateway({}),
        goal,
        allowlist: [origin],
        startUrl: `${origin}/`,
        successChecks: [{ kind: "requestMade", method: "POST", pathGlob: path }],
        safety,
        oracleTimeoutMs: 500,
      }),
    origin,
  );
}

describe("native dialogs follow the run's dialog policy and are logged (#334)", () => {
  it("by default a confirm is dismissed, as before — but the transcript says so", async () => {
    const result = await run("Revoke consent", "0", "/revoke", { allowDestructive: true });
    expect(posts).toEqual([]);
    expect(result.outcome).not.toBe("succeeded");
    const dialogs = result.transcript.flatMap((e) => e.dialogs ?? []);
    expect(dialogs).toEqual([
      expect.objectContaining({ type: "confirm", message: "Revoke consent?", action: "dismissed", why: expect.stringMatching(/--dialogs accept/) }),
    ]);
  });

  it("with dialogs: accept the confirm is accepted and the request goes out", async () => {
    const result = await run("Revoke consent", "0", "/revoke", { allowDestructive: true, dialogs: "accept" });
    expect(posts).toEqual(["/revoke"]);
    expect(result.outcome).toBe("succeeded");
    expect(result.transcript.flatMap((e) => e.dialogs ?? [])).toEqual([
      expect.objectContaining({ type: "confirm", message: "Revoke consent?", action: "accepted" }),
    ]);
  });

  it("accept still dismisses a confirm whose message names a destructive action the run may not take", async () => {
    const result = await run("Withdraw from the showcase program", "1", "/withdraw", { dialogs: "accept" });
    expect(posts).toEqual([]);
    expect(result.transcript.flatMap((e) => e.dialogs ?? [])).toEqual([
      expect.objectContaining({ type: "confirm", action: "dismissed", why: expect.stringMatching(/destructive action \("delete"\).*--allow-destructive/) }),
    ]);
  });
});
