import { createServer, type IncomingMessage, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CHAT_REPLY_STUCK_INSTRUCTIONS,
  FakeGenerationGateway,
  type Answer,
  type GenerationPort,
  type JudgmentPort,
  type JudgmentState,
  type Question,
} from "@jevitate/ai-core";
import { BrowseTheWeb, CastActor } from "@jevitate/screenplay";
import { explore, type ExploreRun } from "./explore.js";
import { parseSecretField, type SecretField } from "./secret-fields.js";
import { withSession } from "./testkit.js";

/**
 * Served fixtures (REAL Chromium) with scripted judges and scripted generators replaying what the
 * Preveti round-2 dogfood recorded on build 147b50b:
 *  - #123: an "add another" participants form — the generator re-offers the FIRST item's name;
 *  - #111: a signup behind a mode toggle — the model never chooses `type` on the bound password;
 *  - #122: a chat whose sidebar re-renders on every turn — the generated turns only acknowledge.
 */

const PASSWORD = `pw-canary-${randomUUID()}`;
const saved: Array<{ name: string; email: string }> = [];
const signups: Array<{ email: string; ok: boolean }> = [];

const PARTICIPANTS_HTML = `<!doctype html><html><body>
<h1>Participants</h1>
<form id="add">
  <label for="name">Name</label> <input id="name" required />
  <label for="email">Email</label> <input id="email" type="email" required />
  <button type="submit">Save participant</button>
</form>
<ul id="list" data-testid="list"></ul>
<script>
  document.getElementById("add").addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = document.getElementById("name").value, email = document.getElementById("email").value;
    await fetch("/participants", { method: "POST", body: JSON.stringify({ name, email }) });
    const li = document.createElement("li"); li.textContent = name + " <" + email + ">"; document.getElementById("list").appendChild(li);
    e.target.reset();
  });
</script>
</body></html>`;

/** #188: an API-keys page — each create shows the same one-time panel (ack checkbox + Done). */
const keys: string[] = [];
const KEYS_HTML = `<!doctype html><html><body>
<h1>API keys</h1>
<button id="new" type="button">Create new key</button>
<form id="create" hidden><label for="kn">Name</label> <input id="kn" required /><button type="submit">Create key</button></form>
<div id="once" hidden><p>Copy this key now.</p>
  <label><input id="ack" type="checkbox" /> I've saved this key somewhere safe.</label>
  <button id="done" type="button" disabled>Done</button></div>
<ul id="list"></ul>
<script>
  const $ = (id) => document.getElementById(id);
  $("new").addEventListener("click", () => { $("create").hidden = false; $("new").hidden = true; });
  $("create").addEventListener("submit", async (e) => {
    e.preventDefault();
    await fetch("/keys", { method: "POST", body: $("kn").value });
    $("create").hidden = true; $("once").hidden = false; $("ack").checked = false; $("done").disabled = true;
    e.target.reset();
  });
  $("ack").addEventListener("change", () => { $("done").disabled = !$("ack").checked; });
  $("done").addEventListener("click", () => { $("once").hidden = true; $("new").hidden = false; });
</script>
</body></html>`;

/** Login first; "Sign up" (a mode toggle OUTSIDE the form) re-renders a signup form (#111). */
const SIGNUP_HTML = `<!doctype html><html><body>
<h1>Welcome</h1>
<button id="mode" type="button">Sign up</button>
<div id="slot"></div>
<div id="twofa" data-testid="page-2fa" hidden>Set up two-factor authentication</div>
<script>
  const slot = document.getElementById("slot");
  const login = '<form id="login"><label for="li-email">Email</label> <input id="li-email" type="email" required />' +
    '<label for="li-pw">Password</label> <input id="li-pw" type="password" required /><button type="submit">Log in</button></form>';
  const signup = '<form id="signup"><label for="su-email">Email</label> <input id="su-email" type="email" required />' +
    '<label for="su-pw">Password</label> <input id="su-pw" type="password" autocomplete="new-password" required />' +
    '<label><input id="terms" type="checkbox" required /> I agree to the Terms</label>' +
    '<button type="submit">Create account</button></form>';
  let mode = "login";
  function render() {
    slot.innerHTML = mode === "login" ? login : signup;
    document.getElementById("mode").textContent = mode === "login" ? "Sign up" : "Log in";
    const f = slot.querySelector("form");
    f.addEventListener("submit", async (e) => {
      e.preventDefault();
      const email = f.querySelector("input[type=email]").value, password = f.querySelector("input[type=password]").value;
      const r = await fetch("/signup", { method: "POST", body: JSON.stringify({ email, password }) });
      if (r.ok) { slot.hidden = true; document.getElementById("twofa").hidden = false; }
    });
  }
  document.getElementById("mode").addEventListener("click", () => { mode = mode === "login" ? "signup" : "login"; render(); });
  render();
</script>
</body></html>`;

/**
 * A chat whose sidebar lists one title per conversation turn ABOVE the transcript (it re-renders on
 * every send, as Preveti's inquiry sidebar did), and an assistant that keeps asking a concrete question.
 */
const CHAT_HTML = `<!doctype html><html><body>
<nav><h2>Inquiries</h2><ul id="side"><li>Why do customers churn?</li></ul></nav>
<main>
<div id="log" role="log"><p>Preveti: Tell me what is going on.</p></div>
<div><input id="box" aria-label="Type a reply" /><button id="send" type="button">Send</button></div>
<a href="#bet">Develop &amp; vet a candidate bet →</a>
</main>
<script>
  const questions = ["Who owns the cancellation data extract?", "By what date can you have it?", "When did the price change take effect?",
    "Which segment cancels most?", "What churn rate would make this bet worth testing?", "Anything else?"];
  let turn = 0;
  function add(where, text) { const p = document.createElement(where === "side" ? "li" : "p"); p.textContent = text; document.getElementById(where).appendChild(p); }
  function submit() {
    const box = document.getElementById("box"); const text = box.value.trim(); if (!text) return;
    add("log", "You: " + text); box.value = "";
    add("side", "Inquiry " + (turn + 2) + ": " + text.slice(0, 40));
    const q = questions[Math.min(turn, questions.length - 1)]; turn += 1;
    setTimeout(() => add("log", "Preveti: Got it. " + q), 300);
  }
  document.getElementById("send").addEventListener("click", submit);
</script>
</body></html>`;

function body(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let b = "";
    req.on("data", (c: Buffer) => (b += c.toString()));
    req.on("end", () => resolve(b));
  });
}

let server: Server;
let base: string;
beforeAll(async () => {
  server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    if (req.method === "POST" && path === "/participants") {
      void body(req).then((b) => {
        saved.push(JSON.parse(b) as { name: string; email: string });
        res.writeHead(201).end();
      });
      return;
    }
    if (req.method === "POST" && path === "/keys") {
      void body(req).then((b) => {
        keys.push(b);
        res.writeHead(201).end();
      });
      return;
    }
    if (req.method === "POST" && path === "/signup") {
      void body(req).then((b) => {
        const { email, password } = JSON.parse(b) as { email: string; password: string };
        const ok = password === PASSWORD;
        signups.push({ email, ok });
        res.writeHead(ok ? 201 : 400).end();
      });
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(path === "/signup" ? SIGNUP_HTML : path === "/chat" ? CHAT_HTML : path === "/keys" ? KEYS_HTML : PARTICIPANTS_HTML);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

/**
 * Picks, per step, the first offered action whose id or description matches the step's pattern
 * (repeating the last); the goal-completion check answers from `met` over the state it is shown.
 */
class PickingJudge implements JudgmentPort {
  #i = 0;
  readonly states: JudgmentState[] = [];
  readonly payloads: string[] = [];
  constructor(
    private readonly steps: readonly RegExp[],
    private readonly met: (s: JudgmentState) => boolean = () => true,
  ) {}
  async systemOne(args: { state: JudgmentState; questions: Record<string, Question> }): Promise<Record<string, Answer>> {
    this.payloads.push(JSON.stringify(args));
    const q = args.questions.action;
    if (q === undefined) {
      const p = this.met(args.state) ? 0.95 : 0.1;
      const out: Record<string, Answer> = {};
      for (const name of Object.keys(args.questions)) out[name] = { kind: "noul", value: p >= 0.5, probability: p };
      return out;
    }
    if (q.kind !== "choice") throw new Error("expected a choice");
    this.states.push(args.state);
    const pattern = this.steps[Math.min(this.#i, this.steps.length - 1)] as RegExp;
    this.#i += 1;
    const pick = q.options.find((o) => pattern.test(o) || pattern.test(q.descriptions?.[o] ?? ""));
    if (pick === undefined) throw new Error(`no option matches ${String(pattern)}: ${q.options.map((o) => `${o}=${q.descriptions?.[o] ?? ""}`).join(", ")}`);
    return { action: { kind: "choice", value: pick, confidence: 0.9 } };
  }
}

/** A generator replaying recorded outputs per task (the last one repeats); every input is kept. */
function scriptedGen(script: { form?: (input: Record<string, unknown>) => string | null; chat?: (input: Record<string, unknown>) => string | null }): {
  gen: GenerationPort;
  inputs: Array<{ kind: string; input: Record<string, unknown> }>;
} {
  const inputs: Array<{ kind: string; input: Record<string, unknown> }> = [];
  const fake = new FakeGenerationGateway();
  const gen: GenerationPort = {
    generate: async (kind, input) => {
      const i = input as Record<string, unknown>;
      inputs.push({ kind, input: i });
      if (kind === "form.value" && script.form !== undefined) {
        return new FakeGenerationGateway({ "form.value": { text: script.form(i) } }).generate(kind, input);
      }
      if (kind === "chat.reply" && script.chat !== undefined) {
        return new FakeGenerationGateway({ "chat.reply": { text: script.chat(i) } }).generate(kind, input);
      }
      return fake.generate(kind, input);
    },
  };
  return { gen, inputs };
}

async function run(
  judge: JudgmentPort,
  gen: GenerationPort,
  path: string,
  goal: string,
  extra: { maxDecisions?: number; secretFields?: SecretField[]; successCheck?: () => Promise<boolean> } = {},
): Promise<ExploreRun> {
  return withSession(
    "values-replies-",
    async (session) =>
      explore({
        actor: CastActor.named("user").whoCan(new BrowseTheWeb(session, [base])),
        judge,
        gen,
        goal,
        allowlist: [base],
        startUrl: `${base}${path}`,
        bounds: { maxDecisions: extra.maxDecisions ?? 12 },
        replyWaitMs: 5_000,
        waitOpMs: 500,
        ...(extra.secretFields === undefined ? {} : { secretFields: extra.secretFields }),
        ...(extra.successCheck === undefined ? {} : { successCheck: extra.successCheck }),
      }),
    base,
  );
}

describe("add-another flow: the second item is the next one, not the first again (#123)", () => {
  it(
    "types two distinct items: a repeat of the first item's name is rejected, the next item is typed",
    async () => {
      saved.length = 0;
      const goal = "Add two customers as private participant contacts: Dana Ruiz (dana@example.com) and Lee Park (lee@example.com).";
      // Recorded: the generator re-offered the first item's name for the second item.
      const names = ["Dana Ruiz", "Dana Ruiz", "Lee Park"];
      const { gen, inputs } = scriptedGen({ form: () => names.shift() ?? "Lee Park" });
      const judge = new PickingJudge([
        /type into textbox "Name"/,
        /type into textbox "Email"/,
        /click button "Save participant"/,
        /type into textbox "Name"/,
        /type into textbox "Name"/,
        /type into textbox "Email"/,
        /click button "Save participant"/,
        /^done$/,
      ]);
      const r = await run(judge, gen, "/participants", goal, { successCheck: async () => saved.length >= 2 });

      expect(saved).toEqual([
        { name: "Dana Ruiz", email: "dana@example.com" },
        { name: "Lee Park", email: "lee@example.com" },
      ]);
      expect(r.stop).toBe("done");
      const rejected = r.transcript.filter((e) => e.reason?.startsWith("typed value rejected"));
      expect(rejected).toHaveLength(1);
      expect(rejected[0]?.reason).toMatch(/repeats "Dana Ruiz", already submitted into this field/);
      // The generator was told what this field already holds, on the second item.
      const nameAsks = inputs.filter((i) => i.kind === "form.value" && i.input.fieldLabel === "Name");
      expect(nameAsks[0]?.input.alreadyUsed).toBeUndefined();
      expect(nameAsks[1]?.input.alreadyUsed).toEqual(["Dana Ruiz"]);
      // Emails come from the goal's item list, in order, without the model.
      expect(inputs.filter((i) => i.kind === "form.value" && i.input.fieldLabel === "Email")).toHaveLength(0);
    },
    120_000,
  );
});

describe("add-another: back on the first item's one-time panel, the model is told what came next (#188)", () => {
  it(
    "after the second create, the history names the acknowledgement steps the same state led to",
    async () => {
      keys.length = 0;
      const goal = "Create two API keys, first 'd3-alpha' then 'd3-beta'. After each is shown once, acknowledge you saved it and close the dialog.";
      const names = ["d3-alpha", "d3-beta"];
      const { gen } = scriptedGen({ form: () => names.shift() ?? "d3-beta" });
      const judge = new PickingJudge([
        /click button "Create new key"/,
        /type into textbox "Name"/,
        /click button "Create key"/,
        /click checkbox "I've saved/,
        /click button "Done"/,
        /click button "Create new key"/,
        /type into textbox "Name"/,
        /click button "Create key"/,
        /click checkbox "I've saved/,
        /click button "Done"/,
        /^done$/,
      ]);
      const r = await run(judge, gen, "/keys", goal, { maxDecisions: 14, successCheck: async () => keys.length >= 2 });
      expect(keys).toEqual(["d3-alpha", "d3-beta"]);
      // The decision after the second "Create key" (the 9th) sees the reminder; the first visit never does.
      const hint = /same state as earlier, where you went on with: click "I've saved this key somewhere safe\."/;
      expect(judge.states[8]?.history.some((h) => hint.test(h))).toBe(true);
      expect(judge.states.slice(0, 8).some((s) => s.history.some((h) => hint.test(h)))).toBe(false);
      expect(r.stop).toBe("done");
    },
    120_000,
  );
});

describe("signup with a bound password the model never chooses to type (#111)", () => {
  it(
    "code types the empty bound password before the form's submit; the signup succeeds with no plaintext anywhere",
    async () => {
      signups.length = 0;
      const secretFields = [parseSecretField("label=Password=env:APP_PASSWORD", "value", { APP_PASSWORD: PASSWORD })];
      const { gen, inputs } = scriptedGen({});
      // Recorded: toggle to Sign up, type Email, tick the terms, submit — never `type` on Password.
      const judge = new PickingJudge([
        /click button "Sign up"/,
        /type into textbox "Email"/,
        /click checkbox "I agree/,
        /click button "Create account"/,
        /^done$/,
      ]);
      const goal = "Create a new account for jevr2-signup@example.com with the bound password, accepting the terms.";
      const r = await withSession(
        "values-replies-",
        async (session) => {
          const actor = CastActor.named("user").whoCan(new BrowseTheWeb(session, [base]));
          const page = session.page;
          return explore({
            actor,
            judge,
            gen,
            goal,
            allowlist: [base],
            startUrl: `${base}/signup`,
            bounds: { maxDecisions: 8 },
            waitOpMs: 500,
            secretFields,
            successCheck: async () => page.getByTestId("page-2fa").isVisible(),
          });
        },
        base,
      );

      expect(signups).toEqual([{ email: "jevr2-signup@example.com", ok: true }]);
      expect(r.stop).toBe("done");
      // Typed by code on its own, with the placeholder only — and only once the signup form was submitted
      // (the mode toggle sits outside the login form: that form's password was never typed).
      const auto = r.transcript.filter((e) => e.strategy === "secret-field");
      expect(auto.map((e) => e.reason)).toEqual(["typed «secret:APP_PASSWORD» (bound secret, typed by code — before submitting with Create account)"]);
      const fills = r.recording.pages.flatMap((p) => p.steps.map((s) => s.step)).filter((s) => s.kind === "fill");
      expect(fills.map((s) => (s.kind === "fill" ? s.value : null))).toContainEqual({ redacted: true, length: PASSWORD.length });
      // The model was told the bound field still needs a `type` step.
      expect(judge.payloads.join("\n")).toContain("choose `type` on it");
      for (const bytes of [...judge.payloads, JSON.stringify(inputs), JSON.stringify(r.recording), JSON.stringify(r.transcript)]) {
        expect(bytes).not.toContain(PASSWORD);
      }
    },
    120_000,
  );
});

describe("a conversation stuck on acknowledgements (#122)", () => {
  it(
    "detects the repeated content-free turns, sends the stuck brief with the assistant's question, and records only the new turn as the reply",
    async () => {
      // Recorded (g-J2-real): every user turn from 3 on acknowledged and never answered.
      const acks = [
        "That makes sense. I'll start compiling that data and get back to you.",
        "I appreciate your insights on the data pull. I'll prioritize getting that information together.",
        "Let's focus on pulling the cancellation data first.",
      ];
      const answers = ["Dana owns the extract; she will have it by October 3.", "The price change took effect on March 3."];
      const { gen, inputs } = scriptedGen({
        chat: (i) => (i.instructions === CHAT_REPLY_STUCK_INSTRUCTIONS ? (answers.shift() ?? "Save a bet: onboarding calls cut churn 20%.") : (acks.shift() ?? "Thanks, got it.")),
      });
      const judge = new PickingJudge([/^send:/], () => false);
      const r = await run(
        judge,
        gen,
        "/chat",
        "Customers keep cancelling after their first month and you don't know why. Talk it through until you have a concrete bet saved.",
        { maxDecisions: 4 },
      );

      const sends = r.transcript.filter((e) => e.op === "send" && e.actOk);
      expect(sends.length).toBe(4);
      // Every reply is the new assistant turn only — never the sidebar titles or older turns.
      for (const s of sends) {
        expect(s.reply?.received).toBe(true);
        expect(s.reply?.text).toMatch(/^Preveti: Got it\. [^\n]+\?$/);
        expect(s.reply?.text).not.toMatch(/Inquir/);
      }
      // After three acknowledgements, the stuck brief was sent with the assistant's latest question.
      const chats = inputs.filter((i) => i.kind === "chat.reply").map((i) => i.input);
      expect(chats.slice(0, 3).every((c) => c.instructions === undefined)).toBe(true);
      expect(chats[3]?.instructions).toBe(CHAT_REPLY_STUCK_INSTRUCTIONS);
      expect(chats[3]?.question).toBe("Preveti: Got it. When did the price change take effect?".replace("Preveti: Got it. ", ""));
      expect(sends[3]?.message).toBe("Dana owns the extract; she will have it by October 3.");
      // The decision was told the conversation is stuck, pointed at the page's call to action.
      const history = judge.states.map((s) => JSON.stringify(s)).join("\n");
      expect(history).toMatch(/the conversation is stuck.*Develop & vet a candidate bet →/);
    },
    120_000,
  );
});
