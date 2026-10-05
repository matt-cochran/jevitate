import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FakeGenerationGateway, type Answer, type JudgmentPort, type JudgmentState, type Question } from "@jevitate/ai-core";
import { BrowseTheWeb, CastActor } from "@jevitate/screenplay";
import { explore } from "./explore.js";
import { withSession, useSkippingTime } from "./testkit.js";

// #304: Node and page time skip idle waits (settle windows, ceilings, job-wait polls).
useSkippingTime({ per: "all" });

/**
 * #379: a page whose only visible state is a busy/progress overlay (a fullscreen spinner covering
 * every control, or a `role=status` "Preparing…" replacing the page) is a job in progress, waited out
 * within --job-wait-ms — never a fail-closed "no interactive controls" at the first look. Past the
 * budget it is the #328 stuck status; a genuinely blank page still fails closed as before.
 */

const hits = new Map<string, number>();
const count = (k: string): number => hits.get(k) ?? 0;

const page = (body: string): string => `<!doctype html><html><head><style>
  .overlay { position: fixed; inset: 0; z-index: 10; background: #fff; display: flex; align-items: center; justify-content: center; }
  .spinner { width: 32px; height: 32px; border: 4px solid #ccc; border-top-color: #333; border-radius: 50%; animation: spin 1s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
</style></head><body>${body}</body></html>`;

/** Apply → a fullscreen overlay with a spinner over every control for `ms` (never, when absent). */
const overlayPage = (ms: number | null): string =>
  page(`
<h1>Design</h1>
<label>Brief <input type="text" aria-label="Brief" value="A calm landing page" /></label>
<button type="button" id="apply">Apply</button>
<script>
  document.getElementById("apply").addEventListener("click", async () => {
    const o = document.createElement("div");
    o.className = "overlay";
    o.innerHTML = '<div role="status"><div class="spinner" aria-label="Preparing design directions"></div>Preparing design directions…</div>';
    document.body.appendChild(o);
    await fetch("/api/apply", { method: "POST", body: "{}" });
    ${
      ms === null
        ? ""
        : `setTimeout(async () => {
      o.remove();
      document.body.innerHTML = '<h1>Design ready</h1><button type="button">Open design</button>';
      await fetch("/api/result");
    }, ${ms});`
    }
  });
</script>`);

/** Apply → the page content is replaced by a bare `role=status` "Preparing…" for `ms`. */
const bareStatusPage = (ms: number): string =>
  page(`
<h1>Design</h1>
<button type="button" id="apply">Apply</button>
<script>
  document.getElementById("apply").addEventListener("click", async () => {
    document.body.innerHTML = '<div role="status">Preparing design directions…</div>';
    await fetch("/api/apply", { method: "POST", body: "{}" });
    setTimeout(async () => {
      document.body.innerHTML = '<h1>Design ready</h1><button type="button">Open design</button>';
      await fetch("/api/result");
    }, ${ms});
  });
</script>`);

/** Apply → a genuinely blank page: no control, no busy sign. */
const BLANK_AFTER = page(`
<h1>Design</h1>
<button type="button" id="apply">Apply</button>
<script>
  document.getElementById("apply").addEventListener("click", () => { document.body.innerHTML = "<p>Thanks.</p>"; });
</script>`);

let server: Server;
let base: string;
beforeAll(async () => {
  server = createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0] ?? "";
    hits.set(`${req.method} ${path}`, count(`${req.method} ${path}`) + 1);
    if (path.startsWith("/api/")) {
      res.writeHead(200, { "content-type": "application/json" }).end("{}");
      return;
    }
    const body = {
      "/overlay-2s": overlayPage(2_000),
      "/overlay-never": overlayPage(null),
      "/status-20s": bareStatusPage(20_000),
      "/blank-after": BLANK_AFTER,
    }[path];
    if (body === undefined) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(body);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});
beforeEach(() => hits.clear());

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

async function runGoal(path: string, extra: { jobWaitMs?: number; renderWaitMs?: number; ignore?: string[] } = {}) {
  return withSession(
    "progress-overlay-served-",
    async (session) => {
      const actor = CastActor.named("served").whoCan(new BrowseTheWeb(session, [base]));
      return explore({
        actor,
        judge: new PickingJudge([/Apply/, /^blocked$/]),
        gen: new FakeGenerationGateway(),
        goal: "apply the brief and open the design",
        allowlist: [base],
        startUrl: `${base}${path}`,
        bounds: { maxDecisions: 3 },
        waitOpMs: 500,
        successMetNow: async () => (count("GET /api/result") > 0 ? "the design result loaded" : null),
        ...(extra.jobWaitMs === undefined ? {} : { jobWaitMs: extra.jobWaitMs }),
        ...(extra.renderWaitMs === undefined ? {} : { renderWaitMs: extra.renderWaitMs }),
        ...(extra.ignore === undefined ? {} : { hangs: { ignoreNoProgress: extra.ignore } }),
      });
    },
    base,
  );
}

const failClosed = (run: Awaited<ReturnType<typeof runGoal>>): boolean =>
  run.transcript.some((e) => /no interactive controls/.test(e.reason ?? ""));

describe("#379 — a progress overlay over every control is a job in progress", () => {
  it("Apply → a fullscreen spinner overlay covers every control for 2s → it clears and the run reaches success", async () => {
    const run = await runGoal("/overlay-2s", { renderWaitMs: 1_000, jobWaitMs: 30_000, ignore: ["Preparing*"] });
    expect(count("POST /api/apply")).toBe(1);
    expect(failClosed(run)).toBe(false);
    const wait = run.transcript.find((e) => e.strategy === "job-wait");
    expect(wait?.reason).toMatch(/no visible control while the page shows .*Preparing design directions.*the overlay cleared/);
    expect(run.stop).toBe("done");
    expect(run.outcome.status).toBe("completed");
  }, 90_000);

  it("Apply → a bare role=status \"Preparing…\" replaces the page for 20s → waited out (perceive, then --job-wait-ms) to success", async () => {
    const run = await runGoal("/status-20s", { jobWaitMs: 60_000 });
    expect(failClosed(run)).toBe(false);
    expect(run.stop).toBe("done");
    expect(run.outcome.status).toBe("completed");
  }, 90_000);

  it("an overlay that never clears ends as the stuck-status no-progress outcome naming it, after --job-wait-ms", async () => {
    const run = await runGoal("/overlay-never", { renderWaitMs: 1_000, jobWaitMs: 5_000, ignore: ["Preparing*"] });
    expect(failClosed(run)).toBe(false);
    expect(run.stop).toBe("no-progress");
    expect(run.outcome.status).toBe("incomplete");
    const last = run.transcript[run.transcript.length - 1];
    expect(last?.reason).toMatch(/^stuck: the page still shows .*Preparing design directions.* past the 5s job-wait budget/);
    expect(run.transcript.filter((e) => e.strategy === "job-wait" && e.actOk).length).toBeGreaterThanOrEqual(1);
  }, 90_000);

  it("a genuinely blank page (no control, no busy sign) still fails closed as before", async () => {
    const run = await runGoal("/blank-after", { jobWaitMs: 30_000 });
    expect(run.stop).toBe("blocked");
    const last = run.transcript[run.transcript.length - 1];
    expect(last?.reason).toBe("page settled with no interactive controls (fail-closed)");
    expect(run.transcript.some((e) => e.strategy === "job-wait")).toBe(false);
  }, 90_000);
});
