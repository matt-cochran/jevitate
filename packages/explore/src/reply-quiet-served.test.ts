import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeGenerationGateway, type Answer, type JudgmentPort, type JudgmentState, type Question } from "@jevitate/ai-core";
import { BrowseTheWeb, CastActor } from "@jevitate/screenplay";
import { clock } from "@jevitate/domain";
import { explore, type ExploreRun } from "./explore.js";
import { withSession, useSkippingTime } from "./testkit.js";

// #304: Node and page time skip idle waits; assertions unchanged.
useSkippingTime({ per: "all" });

/**
 * #331 — an assistant that answers in two parts: "Let me check our next openings" at once, then a
 * card with the time slots that a background poll brings 1.5 s later. A 1 s quiet window can read
 * the reply after the first part (the model then asks for a date it was about to be offered);
 * `replyQuietMs` 2500 reads both parts as one reply.
 */
const CHAT = `<!doctype html><html><head><meta charset="utf-8"></head><body>
<h1>Assistant</h1>
<div id="log" role="log"><p>Assistant: How can I help?</p></div>
<div><input id="box" aria-label="Type a reply" /><button id="send" type="button">Send</button></div>
<script>
  const log = document.getElementById("log");
  const add = (html) => { const d = document.createElement("div"); d.innerHTML = html; log.appendChild(d); };
  let shown = 0;
  // The page polls its message list (a background poll, running since load): the second part of the
  // reply arrives on a later poll.
  setInterval(async () => {
    const msgs = await (await fetch("/api/messages")).json();
    for (const m of msgs.slice(shown)) add(m);
    shown = msgs.length;
  }, 1200);
  document.getElementById("send").onclick = async () => {
    const box = document.getElementById("box");
    if (!box.value.trim()) return;
    add("<p>You: " + box.value + "</p>");
    const text = box.value;
    box.value = "";
    await fetch("/api/send", { method: "POST", body: text });
    add("<p>Assistant: Let me check our next openings</p>");
  };
</script></body></html>`;

const messages: string[] = [];
let timer: ReturnType<typeof setTimeout> | undefined;

let server: Server;
let base: string;
beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === "/api/messages") return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(messages));
    if (req.url === "/api/send") {
      req.resume();
      // The slot card is appended to the message list 1.5 s after the first part.
      // #304: the same clock as the code under test, so skipped idle time moves this timer too.
      timer = clock.setTimeout(() => messages.push('<p>Assistant: Next openings: Tue 9:00, Tue 11:30</p><button type="button">Tue 9:00</button>'), 1_500);
      return void res.writeHead(200, { "content-type": "application/json" }).end("{}");
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(CHAT);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  if (timer !== undefined) clock.clearTimeout(timer);
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});

/** Sends once, then stops. */
class SendOnce implements JudgmentPort {
  #sent = false;
  async systemOne(args: { state: JudgmentState; questions: Record<string, Question> }): Promise<Record<string, Answer>> {
    const q = args.questions.action;
    if (q === undefined) {
      const out: Record<string, Answer> = {};
      for (const name of Object.keys(args.questions)) out[name] = { kind: "noul", value: false, probability: 0.1 };
      return out;
    }
    if (q.kind !== "choice") throw new Error("expected a choice");
    const want = this.#sent ? /^(done|stop|give_up)/ : /^send:/;
    this.#sent = true;
    const pick = q.options.find((o) => want.test(o)) ?? q.options[0]!;
    return { action: { kind: "choice", value: pick, confidence: 0.9 } };
  }
}

async function run(replyQuietMs?: number): Promise<ExploreRun> {
  messages.length = 0;
  return withSession(
    "reply-quiet-",
    async (session) =>
      explore({
        actor: CastActor.named("chat").whoCan(new BrowseTheWeb(session, [base])),
        judge: new SendOnce(),
        gen: new FakeGenerationGateway({ "chat.message": { text: "I'd like the earliest appointment" } }),
        goal: "book the earliest appointment",
        allowlist: [base],
        startUrl: `${base}/chat`,
        bounds: { maxDecisions: 3 },
        replyWaitMs: 15_000,
        waitOpMs: 300,
        ...(replyQuietMs === undefined ? {} : { replyQuietMs }),
      }),
    base,
  );
}

describe("--reply-quiet-ms (#331): a reply in two parts is read whole", () => {
  it("replyQuietMs 2500: both parts are one reply", async () => {
    const r = await run(2_500);
    const reply = r.transcript.find((e) => e.reply !== undefined)?.reply;
    expect(reply?.text).toContain("Let me check our next openings");
    expect(reply?.text).toContain("Next openings: Tue 9:00");
  }, 60_000);
});
