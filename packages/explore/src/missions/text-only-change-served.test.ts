import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeGenerationGateway } from "@jevitate/ai-core";
import { BrowseTheWeb, CastActor } from "@jevitate/screenplay";
import { runGoalBasedMission, type GoalBasedResult } from "./goal-based.js";
import { PreferenceJudge, withSession, type Preference, useSkippingTime } from "../testkit.js";

// #304: Node and page time skip idle waits (settle windows, hang ceilings, polls); assertions unchanged.
useSkippingTime({ per: "all" });

/**
 * #390 — a client-side guided chat (an intake: each Send appends the answer and the next question as
 * bubbles, no request, the same controls) read as "the page did not change": the page signature is
 * the controls' state, so the step after Send looked like the step before typing, the model was never
 * told what appeared, and it ended `blocked`. Repeated "Skip this" clicks (each adds a question) also
 * counted toward no-progress.
 *
 * Text that newly appears after an action is told to the model ("new text appeared: …"), and an
 * action whose only effect is new text is progress.
 */

const QUESTIONS = [
  "What is your company called?",
  "What kind of project is it?",
  "What is your budget?",
  "When do you need it?",
  "Who is the main contact?",
  "Anything else we should know?",
];

const HTML = `<!doctype html><html><body>
<main>
  <h1>Studio intake</h1>
  <p id="progress">0 of ${QUESTIONS.length} details collected</p>
  <ol id="chat"></ol>
  <label for="answer">Your answer</label>
  <input id="answer" type="text" />
  <button type="button" id="send">Send</button>
  <button type="button" id="skip">Skip this</button>
</main>
<script>
  const questions = ${JSON.stringify(QUESTIONS)};
  let at = 0;
  const chat = document.getElementById("chat");
  const bubble = (who, text) => { const li = document.createElement("li"); li.textContent = who + ": " + text; chat.appendChild(li); };
  bubble("Studio", questions[0]);
  const next = () => {
    at += 1;
    document.getElementById("progress").textContent = at + " of " + questions.length + " details collected";
    bubble("Studio", at < questions.length ? questions[at] : "Thanks, that is everything.");
  };
  document.getElementById("send").addEventListener("click", () => {
    const input = document.getElementById("answer");
    if (input.value.trim() === "") return;
    bubble("You", input.value);
    input.value = "";
    next();
  });
  document.getElementById("skip").addEventListener("click", next);
</script>
</body></html>`;

/** A reveal that shows a secret-marked value and a credential-shaped key as plain text. */
const REVEAL = `<!doctype html><html><body><main><h1>Keys</h1>
  <button type="button" id="b">Reveal</button><div data-secret id="k"></div><p id="tok"></p><p id="note"></p></main>
  <script>document.getElementById("b").onclick = () => {
    document.getElementById("k").textContent = "plainmarkedvalue42";
    document.getElementById("tok").textContent = "Key: sk_live_abcdefghijklmnop1234";
    document.getElementById("note").textContent = "Your key is ready";
  };</script></body></html>`;

let server: Server;
let origin: string;
beforeAll(async () => {
  server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(req.url === "/reveal" ? REVEAL : HTML);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function run(
  prefs: (call: number) => readonly Preference[],
  fallback: Preference["op"],
  path = "/intake",
): Promise<{ result: GoalBasedResult; judge: PreferenceJudge }> {
  const judge = new PreferenceJudge((n) => prefs(n), fallback);
  const result = await withSession(
    "text-only-change-",
    async (session) => {
      const actor = CastActor.named("owner").whoCan(new BrowseTheWeb(session, [origin]));
      return runGoalBasedMission({
        actor,
        judge,
        gen: new FakeGenerationGateway({ "form.value": { text: "Acme Ltd" } }),
        goal: "Submit the studio intake by answering its questions.",
        allowlist: [origin],
        startUrl: `${origin}${path}`,
        waitOpMs: 300,
        bounds: { maxDecisions: 14 },
      });
    },
    origin,
  );
  return { result, judge };
}

describe("#390 — a text-only change after an action", () => {
  it(
    "is told to the model: the step after Send says which text appeared",
    async () => {
      const { judge } = await run(
        (n) => (n === 0 ? [{ op: "type", name: "Your answer" }] : n === 1 ? [{ op: "click", name: "Send" }] : []),
        "done",
      );
      const afterSend = judge.states[2]?.history ?? [];
      const line = afterSend.find((h) => /new text appeared/.test(h)) ?? "";
      expect(line, afterSend.join("\n")).toMatch(/after click Send/);
      expect(line).toContain("You: Acme Ltd");
      expect(line).toContain("Studio: What kind of project is it?");
      // "0 of 6" → "1 of 6" is the same line counting up, not new text.
      expect(line).not.toContain("details collected");
      // The control state is the same before typing and after Send — the text is what changed.
      expect(judge.states[2]?.history.some((h) => /did not change/.test(h))).toBe(false);
    },
    90_000,
  );

  it(
    "is progress: clicking Skip through every question is never stopped as no-progress",
    async () => {
      const { result, judge } = await run((n) => (n < QUESTIONS.length ? [{ op: "click", name: "Skip this" }] : []), "done");
      const skips = result.transcript.filter((e) => e.op === "click" && e.actOk && (e.target ?? "").includes('"Skip this"')).length;
      expect(skips, judge.chosen.join("\n")).toBe(QUESTIONS.length);
      expect(result.run.stop).toBe("done");
    },
    90_000,
  );

  it(
    "is told redacted: a secret-marked value or a credential-shaped key that appeared never reaches the model",
    async () => {
      const { judge } = await run((n) => (n === 0 ? [{ op: "click", name: "Reveal" }] : []), "done", "/reveal");
      const told = JSON.stringify(judge.states);
      expect(told).toContain("Your key is ready");
      for (const secret of ["plainmarkedvalue42", "sk_live_abcdefghijklmnop1234"]) expect(told).not.toContain(secret);
    },
    90_000,
  );
});
