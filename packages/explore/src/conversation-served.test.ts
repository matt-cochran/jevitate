import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeGenerationGateway, type Answer, type JudgmentPort, type JudgmentState, type Question } from "@jevitate/ai-core";
import { BrowseTheWeb, CastActor } from "@jevitate/screenplay";
import { explore, type ExploreRun } from "./explore.js";
import { withSession } from "./testkit.js";

/**
 * A chat fixture shaped like the dogfooded Preveti composer: a "Type a reply" box whose Send button is
 * disabled until it has text, where Enter does nothing (only Send submits), replies that take
 * `REPLY_DELAY_MS` behind an aria-busy "Thinking…" indicator, quick-reply chips offered with a reply,
 * and a success line ("Bet saved: …") once the conversation reaches a bet.
 * `?enter=1` is the other composer shape: no Send button, Enter submits.
 */
const REPLY_DELAY_MS = 2_000;

const CHAT_HTML = `<!doctype html><html><body>
<h1>Assistant</h1>
<div id="log" role="log"><p>Assistant: What would you like to work on today?</p></div>
<div id="chips"></div>
<div id="composer"><input id="box" aria-label="Type a reply" /><button id="send" type="button" disabled>Send</button></div>
<script>
  const enterMode = new URLSearchParams(location.search).get("enter") === "1";
  const box = document.getElementById("box");
  const send = document.getElementById("send");
  const log = document.getElementById("log");
  const chips = document.getElementById("chips");
  if (enterMode) send.remove();
  let turn = 0;
  const replies = [
    "Thanks. Which plan do most of the cancelling customers come from?",
    "Understood. Shall I draft a bet you could test next?",
    "Bet saved: a day-3 onboarding call cuts first-month cancellations.",
  ];
  function add(who, text) { const p = document.createElement("p"); p.textContent = who + ": " + text; log.appendChild(p); }
  function submit(text) {
    if (!text.trim()) return;
    add("You", text);
    box.value = ""; if (!enterMode) send.disabled = true;
    chips.innerHTML = "";
    turn += 1;
    const t = turn;
    const busy = document.createElement("p"); busy.setAttribute("aria-busy", "true"); busy.textContent = "Thinking…"; log.appendChild(busy);
    setTimeout(() => {
      busy.remove();
      add("Assistant", replies[Math.min(t, replies.length) - 1]);
      if (t === 2) {
        const b = document.createElement("button"); b.type = "button"; b.textContent = "Yes, draft it";
        b.onclick = () => submit("Yes, draft it"); chips.appendChild(b);
      }
    }, ${REPLY_DELAY_MS});
  }
  box.addEventListener("input", () => { if (!enterMode) send.disabled = box.value.trim() === ""; });
  if (!enterMode) send.addEventListener("click", () => submit(box.value));
  box.addEventListener("keydown", (e) => { if (enterMode && e.key === "Enter") submit(box.value); });
</script>
</body></html>`;

/** A structured form with a native select (dogfood J-5: J3 "Bet size", J7 "Dollars at risk"). */
const SELECT_HTML = `<!doctype html><html><body>
<h1>Stakes</h1>
<label>Bet size <select id="size"><option value="">Choose…</option><option value="s">Small (under $10k)</option><option value="m">Medium ($10k–$100k)</option><option value="l">Large (over $100k)</option></select></label>
<p id="out">No size yet</p>
<script>document.getElementById("size").addEventListener("change", (e) => { document.getElementById("out").textContent = "Stakes saved: " + e.target.selectedOptions[0].textContent; });</script>
</body></html>`;

let server: Server;
let base: string;
beforeAll(async () => {
  server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end((req.url ?? "").startsWith("/select") ? SELECT_HTML : CHAT_HTML);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

/**
 * A judge that picks, per step, the first offered action whose id or description matches the step's
 * pattern (repeating the last step), and answers the goal-completion check from the visible page
 * text it is shown: met only once "Bet saved" is on the page.
 */
class PickingJudge implements JudgmentPort {
  #i = 0;
  readonly actionStates: JudgmentState[] = [];
  readonly goalChecks: number[] = [];
  constructor(private readonly steps: readonly RegExp[]) {}
  async systemOne(args: { state: JudgmentState; questions: Record<string, Question> }): Promise<Record<string, Answer>> {
    const q = args.questions.action;
    if (q === undefined) {
      const met = args.state.controls.some((c) => c.includes("Bet saved"));
      const p = met ? 0.95 : 0.1;
      this.goalChecks.push(p);
      const out: Record<string, Answer> = {};
      for (const name of Object.keys(args.questions)) out[name] = { kind: "noul", value: p >= 0.5, probability: p };
      return out;
    }
    if (q.kind !== "choice") throw new Error("expected a choice");
    this.actionStates.push(args.state);
    const pattern = this.steps[Math.min(this.#i, this.steps.length - 1)] as RegExp;
    this.#i += 1;
    const pick = q.options.find((o) => pattern.test(o) || pattern.test(q.descriptions?.[o] ?? ""));
    if (pick === undefined) throw new Error(`no option matches ${String(pattern)}: ${q.options.join(", ")}`);
    return { action: { kind: "choice", value: pick, confidence: 0.9 } };
  }
}

async function run(judge: JudgmentPort, url: string, extra: { maxDecisions?: number } = {}): Promise<ExploreRun> {
  return withSession(
    "explore-chat-",
    async (session) => {
      const actor = CastActor.named("chat").whoCan(new BrowseTheWeb(session, [base]));
      return explore({
        actor,
        judge,
        gen: new FakeGenerationGateway(),
        goal: "talk it through with the assistant until a bet is saved",
        allowlist: [base],
        startUrl: url,
        bounds: { maxDecisions: extra.maxDecisions ?? 12 },
        replyWaitMs: 15_000,
        waitOpMs: 500,
      });
    },
    base,
  );
}

describe("explore on a chat page — type→submit, awaited replies, multi-turn, grounded done", () => {
  it(
    "sends (type + Send), awaits and records each reply, answers the latest reply, uses the offered chip, and completes",
    async () => {
      const judge = new PickingJudge([
        /^done$/, // an early done: rejected — nothing is visibly achieved yet
        /^send:/,
        /^send:/,
        /Yes, draft it/,
        /^done$/,
      ]);
      const r = await run(judge, `${base}/chat`);

      // The early done was rejected (grounded, not silent), and the final done is verified.
      expect(r.transcript[0]?.op).toBe("done");
      expect(r.transcript[0]?.actOk).toBe(false);
      expect(r.transcript[0]?.reason).toMatch(/done rejected .*not observably achieved/);
      expect(r.stop).toBe("done");
      expect(r.outcome).toEqual({ status: "completed", verifiedBy: "grounded-judgment" });

      // Three conversational turns, each awaited (the fixture replies after 2s) and captured.
      const turns = r.transcript.filter((e) => e.reply !== undefined);
      expect(turns.length).toBeGreaterThanOrEqual(3);
      for (const t of turns) {
        expect(t.reply?.received).toBe(true);
        expect(t.reply?.waitedMs).toBeGreaterThanOrEqual(REPLY_DELAY_MS - 500);
      }
      expect(turns[0]?.reply?.text).toContain("Which plan do most of the cancelling customers come from?");
      expect(turns[1]?.reply?.text).toContain("Shall I draft a bet");
      expect(turns[2]?.message).toBe("Yes, draft it");
      expect(turns[2]?.reply?.text).toContain("Bet saved");

      // Generated messages differ and the second one answers the latest reply (it was in the prompt).
      const sent = r.transcript.filter((e) => e.op === "send").map((e) => e.message);
      expect(sent).toHaveLength(2);
      expect(sent[0]).not.toBe(sent[1]);
      expect(sent[1]).toContain("Thanks. Which plan");

      // No repeated-type loop: no two plain `type` steps without a send between them.
      const ops = r.transcript.map((e) => e.op);
      expect(ops.filter((o) => o === "type")).toHaveLength(0);

      // The model saw the latest reply and the offered chip, flagged as such.
      const chipState = judge.actionStates[3];
      expect(chipState?.controls.some((c) => c.startsWith("LATEST REPLY") && c.includes("Shall I draft a bet"))).toBe(true);
      expect(chipState?.controls.some((c) => c.includes("Yes, draft it") && c.includes("offered with the latest reply"))).toBe(true);

      // The Recording carries type → Send for each message (replayable, not type-only).
      const steps = r.recording.pages.flatMap((p) => p.steps.map((s) => s.step));
      const kinds = steps.map((s) => (s.kind === "click" ? `click:${s.target.role === "button" ? s.target.name ?? "" : ""}` : s.kind));
      expect(kinds.filter((k) => k === "fill")).toHaveLength(2);
      expect(kinds.filter((k) => k === "click:Send")).toHaveLength(2);
    },
    120_000,
  );

  it(
    "catches the repeated-type loop: re-typing unsent text is turned into a send, counted, and ends the run incomplete",
    async () => {
      // The dogfood anti-pattern: the model keeps choosing plain `type` into the composer.
      const judge = new PickingJudge([/^type:/]);
      const r = await run(judge, `${base}/chat`, { maxDecisions: 20 });

      const entries = r.transcript;
      // The first type lands but is NOT a message sent; the repeat is converted into a real send.
      expect(entries[0]?.op).toBe("type");
      expect(entries[1]?.op).toBe("send");
      expect(entries[1]?.reason).toMatch(/repeated type into .* without sending \(stuck signal 1\/3\)/);
      expect(entries[1]?.reply?.received).toBe(true);
      // Never two plain types in a row into the composer.
      for (let i = 1; i < entries.length; i++) {
        expect(entries[i - 1]?.op === "type" && entries[i]?.op === "type" && entries[i]?.actOk).toBe(false);
      }
      expect(r.stop).toBe("no-progress");
      expect(r.outcome.status).toBe("incomplete");
      expect(r.outcome.status === "incomplete" && r.outcome.reason).toMatch(/typed into "Type a reply" 3 times without sending/);
    },
    180_000,
  );

  it(
    "submits with Enter when the composer has no Send control, and records the press",
    async () => {
      const judge = new PickingJudge([/^send:/, /^done$/]);
      const r = await run(judge, `${base}/chat?enter=1`, { maxDecisions: 4 });
      const send = r.transcript.find((e) => e.op === "send");
      expect(send?.reply?.received).toBe(true);
      expect(send?.reply?.text).toContain("Which plan");
      const kinds = r.recording.pages.flatMap((p) => p.steps.map((s) => s.step.kind));
      expect(kinds).toContain("press");
      // Goal not met after one turn: done is rejected and the run says why it ended.
      expect(r.outcome.status).toBe("incomplete");
      expect(r.outcome.status === "incomplete" && r.outcome.reason).toMatch(/budget exhausted|done/);
    },
    120_000,
  );
});

describe("explore on a select — options-aware (J-5)", () => {
  async function selectRun(gen: FakeGenerationGateway): Promise<ExploreRun> {
    return withSession(
      "explore-select-",
      async (session) => {
        const actor = CastActor.named("select").whoCan(new BrowseTheWeb(session, [base]));
        return explore({
          actor,
          judge: new PickingJudge([/^select:/, /^done$/]),
          gen,
          goal: "give the bet a stakes estimate",
          allowlist: [base],
          startUrl: `${base}/select`,
          bounds: { maxDecisions: 2 },
          successCheck: async () => true,
        });
      },
      base,
    );
  }

  it("shows the real options and selects one the page has", async () => {
    const r = await selectRun(new FakeGenerationGateway());
    const sel = r.transcript.find((e) => e.op === "select");
    expect(sel?.target).toContain('options: "Small (under $10k)" | "Medium ($10k–$100k)" | "Large (over $100k)"');
    expect(sel?.actOk).toBe(true);
    expect(r.outcome).toEqual({ status: "completed", verifiedBy: "success-condition" });
  }, 60_000);

  it("never selects a value that is not an option — fails the step fast, no 30s selectOption timeout", async () => {
    const t0 = Date.now();
    const r = await selectRun(new FakeGenerationGateway({ "form.value": { text: "About $50k" } }));
    const sel = r.transcript.find((e) => e.op === "select");
    expect(sel?.actOk).toBe(false);
    expect(sel?.reason).toMatch(/no valid option chosen for Bet size/);
    expect(Date.now() - t0).toBeLessThan(20_000);
  }, 60_000);
});
