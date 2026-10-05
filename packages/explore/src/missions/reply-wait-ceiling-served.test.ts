import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeGenerationGateway } from "@jevitate/ai-core";
import { BrowseTheWeb, CastActor } from "@jevitate/screenplay";
import { runGoalBasedMission } from "./goal-based.js";
import { PreferenceJudge, withSession, useSkippingTime } from "../testkit.js";

// #304: Node and page time skip idle waits (reply waits, polls); assertions unchanged.
useSkippingTime({ per: "all" });

/**
 * #373 — a chat goal run logged 112 consecutive "the reply is still on its way" waits over 19.5 min
 * with nothing in flight: `--reply-ceiling-ms` bounded each wait cycle, never the total wait for the
 * one message sent, so the model's `wait`s re-entered the reply wait forever (until the job timed
 * out). The ceiling bounds the TOTAL wait for one sent message's reply; once spent, the run ends
 * naming the missing reply — while a reply that lands after several waits within it is still taken.
 */

const REPLY_WAIT_MS = 2_000;

/** A chat page; `?late=<ms>` makes the assistant answer that long after the send, with nothing in flight. */
const HTML = `<!doctype html><html><body>
<h1>Assistant</h1>
<div id="log"><p>Assistant: Ask me anything about your account.</p></div>
<input id="box" aria-label="Message" /><button id="send" type="button">Send</button>
<script>
  const late = Number(new URLSearchParams(location.search).get("late") || "0");
  document.getElementById("send").addEventListener("click", () => {
    const box = document.getElementById("box");
    const you = document.createElement("p"); you.textContent = "You: " + box.value;
    document.getElementById("log").appendChild(you);
    fetch("/chat", { method: "POST", body: box.value }).catch(() => {});
    box.value = "";
    if (late > 0) setTimeout(() => {
      const a = document.createElement("p"); a.textContent = "Assistant: Your balance is 42 credits, as of today.";
      document.getElementById("log").appendChild(a);
    }, late);
  });
</script>
</body></html>`;

let server: Server;
let origin: string;
beforeAll(async () => {
  server = createServer((req, res) => {
    // The chat backend accepts the message at once; it never answers over the wire.
    if (req.method === "POST" && req.url === "/chat") return void res.writeHead(204).end();
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(HTML);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** Seconds a transcript entry waited, from its "waited Ns" note. */
const waitedS = (reason: string | undefined): number => Number(/waited (\d+(?:\.\d+)?)s/.exec(reason ?? "")?.[1] ?? 0);

function run(opts: { path: string; ceilingMs: number; maxDecisions: number }) {
  // One message, then the model only ever chooses `wait` (the issue's loop).
  const judge = new PreferenceJudge((n) => (n === 0 ? [{ op: "send", name: "Message" }] : [{ op: "wait" }]));
  return withSession(
    "reply-ceiling-",
    async (session) => {
      const actor = CastActor.named("owner").whoCan(new BrowseTheWeb(session, [origin]));
      return runGoalBasedMission({
        actor,
        judge,
        gen: new FakeGenerationGateway({ "chat.reply": { text: "What is my account balance?" } }),
        goal: "Ask the assistant for your account balance and read its answer.",
        allowlist: [origin],
        startUrl: `${origin}${opts.path}`,
        waitOpMs: 500,
        replyWaitMs: REPLY_WAIT_MS,
        replyCeilingMs: opts.ceilingMs,
        bounds: { maxDecisions: opts.maxDecisions },
      });
    },
    origin,
  );
}

describe("#373 — --reply-ceiling-ms bounds the total wait for one sent message's reply", () => {
  it(
    "a reply that never arrives (nothing in flight) while the model keeps choosing `wait` ends within the ceiling, naming the missing reply",
    async () => {
      const ceilingMs = 30_000;
      const result = await run({ path: "/chat", ceilingMs, maxDecisions: 60 });

      const sends = result.transcript.filter((e) => e.op === "send" && e.actOk);
      expect(sends).toHaveLength(1);
      expect(sends[0]?.reply?.received).toBe(false);
      const waits = result.transcript.filter((e) => e.op === "wait");
      // The wait loop ended long before the decision budget (the issue ran 112 waits).
      expect(waits.length).toBeLessThanOrEqual(5);
      // The total reply wait — the send's and every wait's — stays within the ceiling.
      const total = (sends[0]?.reply?.waitedMs ?? 0) + waits.reduce((s, e) => s + waitedS(e.reason) * 1000, 0);
      expect(total).toBeLessThanOrEqual(ceilingMs + 2_000);
      expect(result.outcome).not.toBe("succeeded");
      expect(result.reason).toMatch(/no reply within \d+s to the last message sent \("What is my account balance\?"\)/);
    },
    120_000,
  );

  it(
    "a reply that lands after several waits, within the ceiling, is still taken",
    async () => {
      const result = await run({ path: "/chat?late=45000", ceilingMs: 120_000, maxDecisions: 10 });

      const sends = result.transcript.filter((e) => e.op === "send" && e.actOk);
      expect(sends).toHaveLength(1);
      expect(sends[0]?.reply?.received).toBe(false);
      const waits = result.transcript.filter((e) => e.op === "wait");
      const landed = waits.findIndex((e) => e.reply?.received === true);
      // Several wait cycles listened before the reply landed, and the reply was recorded.
      expect(landed).toBeGreaterThanOrEqual(2);
      expect(waits[landed]?.reply?.text).toContain("42 credits");
      expect(result.reason ?? "").not.toMatch(/no reply within/);
    },
    120_000,
  );
});
