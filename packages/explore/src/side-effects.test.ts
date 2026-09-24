import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeGenerationGateway, type Answer, type JudgmentPort, type JudgmentState, type Question } from "@jevitate/ai-core";
import { BrowseTheWeb, CastActor } from "@jevitate/screenplay";
import { explore } from "./explore.js";
import type { CapturedRequest, InflightRequest, PageMonitor, RequestCapture } from "./page-monitor.js";
import { SideEffectGuard } from "./side-effects.js";
import { withSession } from "./testkit.js";

/**
 * #92 — the Preveti J7 shape: "Run the simulation →" POSTs a paid job; the loop waits a moment,
 * reloads, and tries the same button again. The second click is refused as a repeated side effect
 * (recorded with its reason) and the POST fires exactly once.
 */
const SIM_HTML = `<!doctype html><html><body>
<h1>Pressure-test the bet</h1>
<button type="button" id="run">Run the simulation →</button>
<p id="state">Not run yet</p>
<script>
  document.getElementById("run").addEventListener("click", async () => {
    document.getElementById("state").textContent = "Simulating…";
    const r = await fetch("/api/simulations", { method: "POST", body: "{}" });
    document.getElementById("state").textContent = r.ok ? "Simulation queued" : "Simulation failed";
  });
</script>
</body></html>`;

let posts = 0;
let server: Server;
let base: string;
beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === "/api/simulations" && req.method === "POST") {
      posts += 1;
      setTimeout(() => res.writeHead(202, { "content-type": "application/json" }).end('{"job":"j1"}'), 300);
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(SIM_HTML);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});

/** Picks, per step, the first offered action whose id or description matches (repeating the last). */
class PickingJudge implements JudgmentPort {
  #i = 0;
  constructor(private readonly steps: readonly RegExp[]) {}
  async systemOne(args: { state: JudgmentState; questions: Record<string, Question> }): Promise<Record<string, Answer>> {
    const q = args.questions.action;
    if (q === undefined) {
      const out: Record<string, Answer> = {};
      for (const name of Object.keys(args.questions)) out[name] = { kind: "noul", value: false, probability: 0.1 };
      return out;
    }
    if (q.kind !== "choice") throw new Error("expected a choice");
    const pattern = this.steps[Math.min(this.#i, this.steps.length - 1)] as RegExp;
    this.#i += 1;
    const pick = q.options.find((o) => pattern.test(o) || pattern.test(q.descriptions?.[o] ?? ""));
    if (pick === undefined) throw new Error(`no option matches ${String(pattern)}: ${q.options.join(", ")}`);
    return { action: { kind: "choice", value: pick, confidence: 0.9 } };
  }
}

describe("#92 — a click that fired a write is not re-fired after wait + reload", () => {
  it("refuses the repeated click with a recorded reason; the POST fires exactly once", async () => {
    posts = 0;
    const run = await withSession(
      "side-effect-repeat-",
      async (session) => {
        const actor = CastActor.named("sim").whoCan(new BrowseTheWeb(session, [base]));
        return explore({
          actor,
          judge: new PickingJudge([/Run the simulation/, /^wait$/, /^reload$/, /Run the simulation/, /Run the simulation/, /^blocked$/]),
          gen: new FakeGenerationGateway(),
          goal: "run the simulation and read the verdict",
          allowlist: [base],
          startUrl: `${base}/decisions/demo`,
          bounds: { maxDecisions: 8 },
          waitOpMs: 500,
        });
      },
      base,
    );
    expect(posts).toBe(1);
    const clicks = run.transcript.filter((e) => e.op === "click");
    expect(clicks[0]?.actOk).toBe(true);
    const refused = clicks.filter((e) => /repeated side effect refused/.test(e.reason ?? ""));
    expect(refused.length).toBeGreaterThanOrEqual(1);
    expect(refused[0]?.actOk).toBe(false);
    expect(refused[0]?.reason).toContain("POST /api/simulations");
    // The reload itself went ahead (nothing was in flight any more) — only the repeat was refused.
    expect(run.transcript.some((e) => e.op === "reload" && e.actOk)).toBe(true);
    // A refusal is never a success.
    expect(run.outcome.status).toBe("incomplete");
  }, 90_000);
});

/** A PageMonitor stand-in: a capture fed by hand and a settable in-flight list. */
function fakeMonitor(): { monitor: PageMonitor; finish: (r: CapturedRequest) => void; inflight: InflightRequest[] } {
  let capture: { add(r: CapturedRequest): void; requests(): CapturedRequest[] } | null = null;
  const inflight: InflightRequest[] = [];
  const monitor = {
    startCapture() {
      const got: CapturedRequest[] = [];
      capture = { add: (r) => got.push(r), requests: () => [...got] };
      return capture as unknown as RequestCapture;
    },
    stopCapture() {
      capture = null;
    },
    pending: () => [...inflight],
  } as unknown as PageMonitor;
  return { monitor, finish: (r) => capture?.add(r), inflight };
}

const PAGE = { controlNames: ["Run the simulation →"], alerts: [] as string[] };
const post = (status: number | null, failed = false): CapturedRequest => ({
  method: "POST",
  url: "http://x/api/simulations",
  path: "/api/simulations",
  status,
  failed,
});

describe("SideEffectGuard (#92)", () => {
  it("allows a click that fired no write, and anything on another route", () => {
    const { monitor } = fakeMonitor();
    const g = new SideEffectGuard(monitor);
    g.beginClick("k", "Open menu", "/a", 0);
    g.settle();
    expect(g.check("k", "/a", PAGE)).toEqual({ refuse: false });
  });

  it("refuses a repeat while the write is in flight, and after it went through", () => {
    const { monitor, inflight, finish } = fakeMonitor();
    const g = new SideEffectGuard(monitor);
    g.beginClick("k", "Run", "/a", 100);
    const req: InflightRequest = { url: "http://x/api/simulations", method: "POST", resourceType: "fetch", startedAt: 150 };
    inflight.push(req);
    g.settle();
    const v = g.check("k", "/a", PAGE);
    expect(v).toMatchObject({ refuse: true, inflight: true });
    expect(g.inflight()).toHaveLength(1);
    inflight.length = 0;
    expect(g.check("k", "/a", PAGE)).toMatchObject({ refuse: true, inflight: false });
    expect(g.check("k", "/elsewhere", PAGE)).toEqual({ refuse: false });
    // A finished 2xx write refuses too.
    g.beginClick("k2", "Save", "/a", 200);
    finish(post(201));
    g.settle();
    expect(g.check("k2", "/a", PAGE)).toMatchObject({ refuse: true, inflight: false });
  });

  it("allows a retry when every write was rejected, or the page offers a retry / shows an error", () => {
    const { monitor, finish } = fakeMonitor();
    const g = new SideEffectGuard(monitor);
    g.beginClick("k", "Run", "/a", 0);
    finish(post(500));
    g.settle();
    expect(g.check("k", "/a", PAGE)).toEqual({ refuse: false });

    g.beginClick("k2", "Run", "/a", 0);
    finish(post(200));
    g.settle();
    expect(g.check("k2", "/a", PAGE).refuse).toBe(true);
    expect(g.check("k2", "/a", { controlNames: ["Try again"], alerts: [] })).toEqual({ refuse: false });
    expect(g.check("k2", "/a", { controlNames: [], alerts: ["Something went wrong"] })).toEqual({ refuse: false });
  });

  it("an input change clears the guard (a repeat now sends something new)", () => {
    const { monitor, finish } = fakeMonitor();
    const g = new SideEffectGuard(monitor);
    g.beginClick("k", "Save", "/a", 0);
    finish(post(200));
    g.settle();
    expect(g.check("k", "/a", PAGE).refuse).toBe(true);
    g.inputChanged();
    expect(g.check("k", "/a", PAGE)).toEqual({ refuse: false });
  });
});
