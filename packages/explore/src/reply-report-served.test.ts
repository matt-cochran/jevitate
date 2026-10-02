import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeGenerationGateway } from "@jevitate/ai-core";
import { BrowseTheWeb, CastActor } from "@jevitate/screenplay";
import { explore, type ExploreRun } from "./explore.js";
import { ScriptedJudge, withSession, useSkippingTime } from "./testkit.js";

// #304: Node and page time skip idle waits (settle windows, hang ceilings, polls); assertions unchanged.
useSkippingTime({ per: "all" });

/**
 * #200 — a find-out goal about an assistant's REPLY ("ask the assistant X, wait for its reply, and
 * report the reply") was accepted grounded on the chat panel's static intro copy, on screen before
 * any message was sent. Code now grounds such a report only on text that appeared after the send;
 * no reply within the reply wait → rejected "no reply observed".
 *
 * `?mode=none`: the send is echoed but no reply ever comes (a broken backend).
 * `?mode=reply`: a reply arrives after a short delay.
 * `?mode=echo`: the reply repeats words of the intro copy.
 */
const CHAT_HTML = `<!doctype html><html><body>
<h1>Help</h1>
<p>Ask me anything about using the app</p>
<div id="log" role="log"></div>
<input id="box" aria-label="Message" /><button id="send" type="button">Send</button>
<script>
  const mode = new URLSearchParams(location.search).get("mode");
  const log = document.getElementById("log");
  const box = document.getElementById("box");
  function add(text) { const p = document.createElement("p"); p.textContent = text; log.appendChild(p); }
  function submit() {
    const text = box.value;
    if (!text.trim()) return;
    add("You: " + text);
    box.value = "";
    if (mode === "none") return;
    setTimeout(() => {
      add(mode === "echo"
        ? "Assistant: Anything about using the app is fine: exports live under Settings > Data."
        : "Assistant: Exports live under Settings > Data.");
    }, 400);
  }
  document.getElementById("send").addEventListener("click", submit);
  box.addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); });
</script>
</body></html>`;

let server: Server;
let base: string;
beforeAll(async () => {
  server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(CHAT_HTML);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

const GOAL = "Ask the assistant how to export my data, wait for its reply, and report the reply.";

async function run(mode: string, judge: ScriptedJudge, gen = new FakeGenerationGateway()): Promise<ExploreRun> {
  return withSession(
    "explore-reply-report-",
    async (session) => {
      const actor = CastActor.named("reply-report").whoCan(new BrowseTheWeb(session, [base]));
      return explore({
        actor,
        judge,
        gen,
        goal: GOAL,
        allowlist: [base],
        startUrl: `${base}/?mode=${mode}`,
        bounds: { maxDecisions: 8 },
        replyWaitMs: 1_500,
        replyCeilingMs: 3_000,
      });
    },
    base,
  );
}

const reports = (r: ExploreRun) => r.transcript.filter((e) => e.op === "report");

describe("#200 — a report about a reply is grounded only on text that appeared after the send", () => {
  it(
    "no reply ever arrives → the report is rejected 'no reply observed', never grounded on the intro copy",
    async () => {
      const judge = new ScriptedJudge([{ op: "send", target: "0" }, { op: "report" }]);
      const r = await run("none", judge);

      expect(r.transcript.some((e) => e.op === "send" && e.actOk)).toBe(true);
      expect(r.answer).toBeUndefined();
      expect(r.outcome.status).toBe("incomplete");
      expect(reports(r).length).toBeGreaterThan(0);
      expect(reports(r).every((e) => !e.actOk)).toBe(true);
      expect(reports(r)[0]?.reason).toMatch(/report rejected \(1\/3\): no reply observed/);
      expect(r.transcript.some((e) => /report accepted/.test(e.reason ?? ""))).toBe(false);
    },
    60_000,
  );

  it(
    "a report before any message was sent is rejected too — the intro copy is not a reply",
    async () => {
      const judge = new ScriptedJudge([{ op: "report" }]);
      const r = await run("reply", judge);
      expect(r.answer).toBeUndefined();
      expect(reports(r)[0]?.reason).toMatch(/no reply observed/);
    },
    60_000,
  );

  it(
    "a reply appears after the send → accepted, grounded on the reply text",
    async () => {
      const judge = new ScriptedJudge([{ op: "send", target: "0" }, { op: "report" }]);
      const r = await run("reply", judge);

      expect(r.stop).toBe("done");
      expect(r.outcome).toEqual({ status: "completed", verifiedBy: "grounded-answer" });
      expect(r.answer?.evidence.length).toBeGreaterThan(0);
      expect(r.answer?.evidence.every((e) => e.grounded && /Exports live under Settings > Data/.test(e.quote))).toBe(true);
      expect(r.answer?.text).not.toMatch(/Ask me anything/);
      expect(reports(r).at(-1)?.reason).toMatch(/report accepted: answer grounded on the reply observed after the send/);
    },
    60_000,
  );

  it(
    "the reply repeats words from the intro → a quote of the intro copy is rejected; a quote of the new message is accepted",
    async () => {
      const introGen = new FakeGenerationGateway({
        "goal.answer": {
          answer: "The assistant said: ask me anything about using the app.",
          claims: [{ claim: "The assistant invites any question about using the app", quote: "Ask me anything about using the app" }],
        },
      });
      const bad = await run("echo", new ScriptedJudge([{ op: "send", target: "0" }, { op: "report" }]), introGen);
      expect(bad.answer).toBeUndefined();
      expect(reports(bad)[0]?.reason).toMatch(/report rejected \(1\/3\): the answer is not grounded: .* quote not found/);

      const replyGen = new FakeGenerationGateway({
        "goal.answer": {
          answer: "Exports live under Settings > Data.",
          claims: [{ claim: "Exports live under Settings > Data", quote: "exports live under Settings > Data" }],
        },
      });
      const good = await run("echo", new ScriptedJudge([{ op: "send", target: "0" }, { op: "report" }]), replyGen);
      expect(good.outcome).toEqual({ status: "completed", verifiedBy: "grounded-answer" });
      expect(good.answer?.evidence[0]?.grounded).toBe(true);
    },
    60_000,
  );
});
