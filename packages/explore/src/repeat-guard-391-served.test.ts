import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FakeGenerationGateway, type Answer, type JudgmentPort, type JudgmentState, type Question } from "@jevitate/ai-core";
import { BrowseTheWeb, CastActor } from "@jevitate/screenplay";
import { explore } from "./explore.js";
import { withSession, useSkippingTime } from "./testkit.js";

// #304: Node and page time skip idle waits (settle windows, polls); assertions unchanged.
useSkippingTime({ per: "all" });

/**
 * #391 (a regression of #380 on 0.6.0) — the zonetico domain wizard: "I've changed my nameservers"
 * sends `RefreshShareDomain`; once "Review instructions" (a control in the SAME card) has been used,
 * the same button sends `RetryShareDomain` (`if (instructions) onRetry() else onRefresh()`). The
 * instructions open in their own section, outside the button's card, so the card's text and controls
 * never change — the region-state rule alone refused the click and the run blocked.
 */
const connect = (method: string): string =>
  `fetch("${method}", { method: "POST", headers: { "content-type": "application/connect+json" }, body: "{}" })`;

const WIZARD = `<!doctype html><html><body>
<header><button type="button" id="help" aria-expanded="false">Help</button><p id="tips" hidden>Ask support.</p></header>
<main><h1>Change your nameservers</h1>
<section class="card">
  <p>Point your nameservers at ns1.example.net, then tell us.</p>
  <div class="actions">
    <button type="button" id="review">Review instructions</button>
    <button type="button" id="changed">I've changed my nameservers</button>
  </div>
</section>
<section id="instructions" hidden><h2>Instructions</h2><p>Sign in to your registrar and replace the nameservers.</p></section>
</main>
<script>
  let instructions = false;
  document.getElementById("review").addEventListener("click", () => {
    instructions = true;
    document.getElementById("instructions").hidden = false;
  });
  document.getElementById("help").addEventListener("click", () => {
    const tips = document.getElementById("tips");
    tips.hidden = !tips.hidden;
    document.getElementById("help").setAttribute("aria-expanded", String(!tips.hidden));
  });
  document.getElementById("changed").addEventListener("click", async () => {
    if (instructions) await ${connect("/portal.v1.AgencySetupService/RetryShareDomain")};
    else await ${connect("/portal.v1.AgencySetupService/RefreshShareDomain")};
  });
</script>
</body></html>`;

const hits = new Map<string, number>();
const count = (k: string): number => hits.get(k) ?? 0;
let server: Server;
let base: string;
beforeAll(async () => {
  server = createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0] ?? "";
    if (req.method !== "GET") {
      hits.set(`${req.method} ${path}`, count(`${req.method} ${path}`) + 1);
      res.writeHead(200, { "content-type": "application/json" }).end("{}");
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(WIZARD);
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

const run = (steps: readonly RegExp[]) =>
  withSession(
    "repeat-391-",
    async (session) => {
      const actor = CastActor.named("guard").whoCan(new BrowseTheWeb(session, [base]));
      return explore({
        actor,
        judge: new PickingJudge(steps),
        gen: new FakeGenerationGateway(),
        goal: "connect the domain",
        allowlist: [base],
        startUrl: `${base}/wizard`,
        bounds: { maxDecisions: steps.length },
      });
    },
    base,
  );

const REFRESH = "POST /portal.v1.AgencySetupService/RefreshShareDomain";
const RETRY = "POST /portal.v1.AgencySetupService/RetryShareDomain";

describe("#391 — a same-labelled control that sends another RPC after a control beside it was used", () => {
  it("Refresh → Review instructions → RetryShareDomain goes through; the same click again is refused", async () => {
    const r = await run([/I've changed my nameservers/, /Review instructions/, /I've changed my nameservers/, /I've changed my nameservers/, /^blocked$/]);
    const clicks = r.transcript.filter((e) => e.op === "click");
    expect(clicks.slice(0, 3).map((e) => e.actOk)).toEqual([true, true, true]);
    expect(clicks[2]?.reason ?? "").not.toMatch(/repeated side effect/);
    expect(count(REFRESH)).toBe(1);
    expect(count(RETRY)).toBe(1);
    // Nothing used since: a true repeat of the write it just sent, named by THAT request.
    expect(clicks[3]?.actOk).toBe(false);
    expect(clicks[3]?.reason).toMatch(/repeated side effect refused/);
    expect(clicks[3]?.reason).toContain(RETRY);
    expect(count(RETRY)).toBe(1);
  }, 90_000);

  it("a genuine repeat (nothing used in between) is still refused", async () => {
    const r = await run([/I've changed my nameservers/, /I've changed my nameservers/, /^blocked$/]);
    const clicks = r.transcript.filter((e) => e.op === "click");
    expect(clicks[0]?.actOk).toBe(true);
    expect(clicks[1]?.actOk).toBe(false);
    expect(clicks[1]?.reason).toContain(REFRESH);
    expect(count(REFRESH)).toBe(1);
  }, 90_000);

  it("a control used elsewhere on the page (a header menu) is no change: still refused", async () => {
    const r = await run([/I've changed my nameservers/, /Help/, /I've changed my nameservers/, /^blocked$/]);
    const clicks = r.transcript.filter((e) => e.op === "click");
    expect(clicks.slice(0, 2).map((e) => e.actOk)).toEqual([true, true]);
    expect(clicks[2]?.actOk).toBe(false);
    expect(clicks[2]?.reason).toContain(REFRESH);
    expect(count(REFRESH)).toBe(1);
    expect(count(RETRY)).toBe(0);
  }, 90_000);
});
