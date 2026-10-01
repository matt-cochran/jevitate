import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FakeGenerationGateway } from "@jevitate/ai-core";
import { BrowseTheWeb, CastActor } from "@jevitate/screenplay";
import { explore, type ExploreRun } from "../explore.js";
import { ScriptedJudge, withSession } from "../testkit.js";

/**
 * #241 × #283 on a served chat (real Chromium). #241 stopped counting the page's background polling
 * as a reply being worked on: an endpoint the page requested before the send is background. But the
 * run's OWN previous turn wrote to the chat endpoint too, so a second message's `POST /api/chat` —
 * the LLM call itself, held open while the model thinks — was taken for background traffic: the reply
 * wait saw "no sign of work", gave up after the idle patience and missed the reply. An in-flight
 * first-party write the action started IS activity; the page's background poll is not — neither
 * while the reply is awaited nor while a landed reply is settling.
 */

const HTML = `<!doctype html><html><body>
<h1>Assistant</h1>
<p>Balance: <span id="bal">0</span> credits</p>
<div id="log" role="log"></div>
<input id="box" aria-label="Message" /><button id="send" type="button">Send</button>
<script>
  // A background poll that re-renders only on change (as a framework would).
  const poll = () => fetch("/api/balance").then((r) => r.json()).then((b) => { const el = document.getElementById("bal"); if (el.textContent !== String(b.credits)) el.textContent = String(b.credits); }).catch(() => {});
  poll();
  setInterval(poll, 1000);
  const log = document.getElementById("log");
  const box = document.getElementById("box");
  function add(text) { const p = document.createElement("p"); p.textContent = text; log.appendChild(p); }
  async function submit() {
    const text = box.value;
    if (!text.trim()) return;
    add("You: " + text);
    box.value = "";
    const r = await fetch("/api/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }) });
    add("Assistant: " + (await r.json()).reply);
  }
  document.getElementById("send").addEventListener("click", submit);
  box.addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); });
</script>
</body></html>`;

/** How long the SECOND chat turn's LLM call takes (ms) — well past the idle patience below. */
const SLOW_TURN_MS = 9_000;
let chats = 0;
let server: Server;
let origin: string;
beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url?.startsWith("/api/balance")) return void res.writeHead(200, { "content-type": "application/json" }).end('{"credits":3}');
    if (req.method === "POST" && req.url === "/api/chat") {
      chats += 1;
      const n = chats;
      req.resume();
      const answer = (): void => {
        if (!res.writableEnded) res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ reply: n === 1 ? "Hello there, first answer." : "Exports live under Settings, second answer." }));
      };
      if (n === 1) answer();
      else setTimeout(answer, SLOW_TURN_MS);
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(HTML);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
beforeEach(() => {
  chats = 0;
});

async function run(): Promise<ExploreRun> {
  return withSession(
    "second-turn-reply-",
    async (session) => {
      const actor = CastActor.named("chatter").whoCan(new BrowseTheWeb(session, [origin]));
      return explore({
        actor,
        // Controls: [0] Message, [1] Send.
        judge: new ScriptedJudge([{ op: "send", target: "0" }, { op: "send", target: "0" }, { op: "blocked" }]),
        gen: new FakeGenerationGateway(),
        goal: "Ask the assistant two questions about exporting data.",
        allowlist: [origin],
        startUrl: `${origin}/chat`,
        bounds: { maxDecisions: 4 },
        // Idle patience (after the send's ~3s not-sent check) well below the slow turn; the ceiling above it.
        replyWaitMs: 4_000,
        replyCeilingMs: 20_000,
      });
    },
    origin,
  );
}

describe("#241 × #283 — the next chat turn's own in-flight write is the reply being worked on", () => {
  it(
    "a second message whose POST is held past the idle patience is awaited until its reply lands",
    async () => {
      const r = await run();
      expect(chats).toBe(2);
      const sends = r.transcript.filter((e) => e.op === "send" && e.actOk);
      expect(sends).toHaveLength(2);
      expect(sends[0]?.reply).toMatchObject({ received: true });
      expect(sends[1]?.reply).toMatchObject({ received: true });
      expect(sends[1]?.reply?.text).toContain("second answer");
    },
    90_000,
  );

  it(
    "the page's background poll never holds a landed reply's settle open (the reply is taken once it holds still)",
    async () => {
      const r = await run();
      const first = r.transcript.find((e) => e.op === "send" && e.actOk);
      expect(first?.reply).toMatchObject({ received: true });
      // The first reply lands at once: the send's ~3s not-sent check plus the quiet window — never
      // the 15s settle ceiling a 1s poll used to keep open.
      expect(first?.reply?.waitedMs).toBeLessThan(10_000);
    },
    90_000,
  );
});
