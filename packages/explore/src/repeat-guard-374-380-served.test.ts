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
 * #374 — a click whose only first-party write is bookkeeping (an analytics event RPC, a
 * `Mark*Read` marker, an `/analytics` POST) is not a side effect: re-clicking it is allowed.
 * #380 — "I've changed my nameservers" sends `RefreshShareDomain`; once the screen has moved on the
 * same button sends `RetryShareDomain` and goes through; a true repeat on an unchanged screen is
 * still refused, named by the request it sent.
 */
const connect = (method: string): string =>
  `fetch("${method}", { method: "POST", headers: { "content-type": "application/connect+json" }, body: "{}" })`;

const INBOX = `<!doctype html><html><body>
<h1>Inbox</h1>
<a href="#chat" id="chat">Chat with us</a>
<ul><li><button type="button" id="row">Alex Morgan — Re: your order</button></li></ul>
<section id="panel"></section>
<script>
  document.getElementById("chat").addEventListener("click", (e) => {
    e.preventDefault();
    ${connect("/showcase.analytics.v1.ShowcaseService/RecordShowcaseEvent")};
    fetch("/api/analytics/events", { method: "POST", body: "{}" });
    document.getElementById("panel").textContent = "Chat: how can we help?";
  });
  document.getElementById("row").addEventListener("click", () => {
    ${connect("/inbox.v1.InboxService/MarkConversationRead")};
    document.getElementById("panel").textContent = "Alex Morgan: is my order on its way?";
  });
</script>
</body></html>`;

const DOMAIN = `<!doctype html><html><body>
<h1>Connect your domain</h1>
<p id="status">Point your nameservers at ns1.example.net, then tell us.</p>
<button type="button" id="changed">I've changed my nameservers</button>
<button type="button" id="check">Check status</button>
<script>
  let checked = false;
  const status = document.getElementById("status");
  document.getElementById("changed").addEventListener("click", async () => {
    if (!checked) {
      await ${connect("/share.v1.ShareService/RefreshShareDomain")};
      status.textContent = "Checking your nameservers. This can take a while.";
    } else {
      await ${connect("/share.v1.ShareService/RetryShareDomain")};
      status.textContent = "Domain connected.";
    }
  });
  document.getElementById("check").addEventListener("click", async () => {
    await fetch("/api/share-domain/status");
    checked = true;
    status.textContent = "The nameservers still point elsewhere. Change them, then tell us again.";
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
    if (req.method !== "GET" || path.startsWith("/api/")) {
      hits.set(`${req.method} ${path}`, count(`${req.method} ${path}`) + 1);
      res.writeHead(200, { "content-type": "application/json" }).end("{}");
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(path === "/domain" ? DOMAIN : INBOX);
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

const run = (path: string, goal: string, steps: readonly RegExp[]) =>
  withSession(
    "repeat-374-380-",
    async (session) => {
      const actor = CastActor.named("guard").whoCan(new BrowseTheWeb(session, [base]));
      return explore({
        actor,
        judge: new PickingJudge(steps),
        gen: new FakeGenerationGateway(),
        goal,
        allowlist: [base],
        startUrl: `${base}${path}`,
        bounds: { maxDecisions: steps.length },
      });
    },
    base,
  );

describe("#374 — bookkeeping requests never make a click a repeated side effect", () => {
  it("re-clicking a link that records an analytics event and a row that marks a conversation read is allowed", async () => {
    const r = await run("/inbox", "open the chat and the conversation with Alex twice", [
      /Chat with us/,
      /Chat with us/,
      /Alex Morgan/,
      /Alex Morgan/,
      /^blocked$/,
    ]);
    const clicks = r.transcript.filter((e) => e.op === "click");
    expect(clicks.map((e) => e.actOk)).toEqual([true, true, true, true]);
    expect(r.transcript.some((e) => /repeated side effect refused/.test(e.reason ?? ""))).toBe(false);
    expect(count("POST /showcase.analytics.v1.ShowcaseService/RecordShowcaseEvent")).toBe(2);
    expect(count("POST /inbox.v1.InboxService/MarkConversationRead")).toBe(2);
  }, 90_000);
});

describe("#380 — one control, another request once the screen has moved on", () => {
  it("RefreshShareDomain, then (screen moved on) RetryShareDomain goes through; a true repeat is still refused", async () => {
    const r = await run("/domain", "connect the domain", [
      /I've changed my nameservers/,
      /Check status/,
      /I've changed my nameservers/,
      /I've changed my nameservers/,
      /^blocked$/,
    ]);
    const clicks = r.transcript.filter((e) => e.op === "click");
    expect(clicks.slice(0, 3).map((e) => e.actOk)).toEqual([true, true, true]);
    expect(clicks[2]?.reason ?? "").not.toMatch(/repeated side effect/);
    expect(count("POST /share.v1.ShareService/RefreshShareDomain")).toBe(1);
    expect(count("POST /share.v1.ShareService/RetryShareDomain")).toBe(1);
    // The same button on the unchanged "Domain connected." screen: a true repeat, named by ITS request.
    expect(clicks[3]?.actOk).toBe(false);
    expect(clicks[3]?.reason).toMatch(/repeated side effect refused/);
    expect(clicks[3]?.reason).toContain("POST /share.v1.ShareService/RetryShareDomain");
    expect(clicks[3]?.reason).toContain("the screen has not moved on since");
  }, 90_000);

  it("a true repeat right after the first write (the screen it produced, unchanged) is refused", async () => {
    const r = await run("/domain", "connect the domain", [/I've changed my nameservers/, /I've changed my nameservers/, /^blocked$/]);
    const clicks = r.transcript.filter((e) => e.op === "click");
    expect(clicks[0]?.actOk).toBe(true);
    expect(clicks[1]?.actOk).toBe(false);
    expect(clicks[1]?.reason).toContain("POST /share.v1.ShareService/RefreshShareDomain");
    expect(count("POST /share.v1.ShareService/RefreshShareDomain")).toBe(1);
    expect(count("POST /share.v1.ShareService/RetryShareDomain")).toBe(0);
  }, 90_000);
});
