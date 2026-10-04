import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { clock } from "@jevitate/domain";
import { FakeGenerationGateway } from "@jevitate/ai-core";
import { BrowseTheWeb, CastActor } from "@jevitate/screenplay";
import { runGoalBasedMission } from "./goal-based.js";
import { ScriptedJudge, withSession, useSkippingTime } from "../testkit.js";

// #304: Node and page time skip idle waits; assertions unchanged.
useSkippingTime({ per: "all" });

/**
 * #330 — a long engine call: the page shows a role=status "Designing variations…" overlay while
 * its request is in flight (no Cancel, no disabled button). With --job-wait-ms the operator sized
 * that job: the request-pending hang is deferred within the budget. Without it a bare status is
 * not enough (#153: a stuck page looks exactly like that) — unchanged.
 */
const held: ServerResponse[] = [];
const timers: ReturnType<typeof setTimeout>[] = [];
const page = (endpoint: string): string => `<!doctype html><html><body><div id="root"><button type="button" id="go">Generate</button></div><script>
  document.getElementById("go").onclick = () => {
    const root = document.getElementById("root");
    root.innerHTML = '<div role="status">Designing variations…</div>';
    fetch("${endpoint}", { method: "POST" }).then(() => { root.innerHTML = '<p>Variations ready</p><button type="button">Pick one</button>'; });
  };
</script></body></html>`;

let server: Server;
let origin: string;
beforeAll(async () => {
  server = createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0] ?? "";
    if (path === "/design") return void res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(page("/api/design"));
    if (path === "/design-stuck") return void res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(page("/api/design-never"));
    if (path === "/api/design") {
      // The engine call (15–75 s in the issue, scaled down): answers after 6 s.
      timers.push(clock.setTimeout(() => res.writeHead(200, { "content-type": "application/json" }).end("{}"), 6_000));
      return;
    }
    if (path === "/api/design-never") return void held.push(res);
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  for (const t of timers) clock.clearTimeout(t);
  for (const r of held) r.destroy();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const FAST = { renderWaitMs: 4_000, requestBoundMs: 3_000, hangProbeMs: 2_000 };

const run = (path: string, jobWaitMs?: number) =>
  withSession(
    "hang-status-pending-",
    async (session) =>
      runGoalBasedMission({
        actor: CastActor.named("designer").whoCan(new BrowseTheWeb(session, [origin])),
        judge: new ScriptedJudge([{ op: "click", target: "0" }, { op: "done" }]),
        gen: new FakeGenerationGateway(),
        goal: "generate design variations",
        allowlist: [origin],
        startUrl: `${origin}${path}`,
        successAssertion: { kind: "visible", target: { text: "Variations ready" } },
        ...(jobWaitMs === undefined ? {} : { jobWaitMs }),
        oracleTimeoutMs: 2_000,
        bounds: { maxDecisions: 6 },
        ...FAST,
      }),
    origin,
  );

describe("#330 — a visible in-progress status over a pending request uses --job-wait-ms", () => {
  it("with --job-wait-ms, the engine call is waited out: the goal succeeds, no request-pending hang", async () => {
    const r = await run("/design", 30_000);
    expect(r.hang).toBeUndefined();
    expect(r.outcome).toBe("succeeded");
    expect(r.transcript.some((e) => /not a hang yet \(request-pending\).*Designing variations.*while its request is in flight/.test(e.reason ?? ""))).toBe(true);
  }, 90_000);

  it("past the --job-wait-ms budget the hang stands", async () => {
    const r = await run("/design-stuck", 2_000);
    expect(r.transcript.some((e) => /not a hang yet/.test(e.reason ?? ""))).toBe(true);
    expect(r.run.stop).toBe("hang");
    expect(r.hang?.hangKind).toBe("request-pending");
  }, 90_000);

  it("without --job-wait-ms a bare status is not enough: request-pending, as before", async () => {
    const r = await run("/design-stuck");
    expect(r.transcript.some((e) => /not a hang yet/.test(e.reason ?? ""))).toBe(false);
    expect(r.run.stop).toBe("hang");
    expect(r.hang?.hangKind).toBe("request-pending");
  }, 90_000);
});
