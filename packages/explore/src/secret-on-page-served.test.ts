import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  FakeGenerationGateway,
  FakeJudgmentGateway,
  REDACTION_MASK,
  type GenerationPort,
  type JudgmentPort,
} from "@jevitate/ai-core";
import { BrowseTheWeb, CastActor } from "@jevitate/screenplay";
import { explore, type ExploreRun } from "./explore.js";
import { WITHHELD_ANSWER_NOTE } from "./answer.js";
import { readPageText } from "./conversation.js";
import { perceive } from "./perceive.js";
import { runAdversarialMission } from "./missions/adversarial.js";
import { ScriptedJudge, withSession, useSkippingTime } from "./testkit.js";

// #304: Node and page time skip idle waits (settle windows, hang ceilings, polls); assertions unchanged.
useSkippingTime({ per: "all" });

/**
 * #219 — a registered secret the page merely DISPLAYS (a profile page showing the signed-in email, in
 * its text and in an input's value) is redacted as the page is perceived, before any model payload is
 * built: every strategy completes (no "recording rejected" crash), and no judgment/generation payload,
 * transcript, Recording or answer carries the value. A find-out whose true answer IS the secret says
 * it cannot disclose it. Served page, real Chromium, spied gateways.
 */

const SECRET = "test@example.test";
const forms = [SECRET, encodeURIComponent(SECRET)];
const leaks = (x: unknown): boolean => {
  const s = typeof x === "string" ? x : JSON.stringify(x);
  return forms.some((f) => s.includes(f));
};

const PAGE = `<!doctype html><html><head><title>Profile</title></head><body>
<h1>Profile settings</h1>
<p>Signed in as ${SECRET}</p>
<a href="/profile?email=${encodeURIComponent(SECRET)}">Reload profile</a>
<form id="f">
  <label>Display name <input name="displayName" aria-label="Display name" value="Ada"></label>
  <label>Email <input name="email" type="email" aria-label="Email" value="${SECRET}"></label>
  <button type="submit">Save</button>
</form>
<p role="status" id="s"></p>
<script>
  document.getElementById("f").addEventListener("submit", async (e) => {
    e.preventDefault();
    const body = JSON.stringify(Object.fromEntries(new FormData(e.target)));
    await fetch("/api/profile", { method: "PUT", headers: { "content-type": "application/json" }, body });
    document.getElementById("s").textContent = "Saved " + e.target.email.value;
  });
</script>
</body></html>`;

let server: Server;
let origin: string;
beforeAll(async () => {
  server = createServer((req, res) => {
    if ((req.url ?? "").startsWith("/api/")) {
      req.resume();
      res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(PAGE);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

/** A generation gateway that records every payload it is handed. */
function spyGen(inner: GenerationPort): { gen: GenerationPort; inputs: unknown[] } {
  const inputs: unknown[] = [];
  return {
    inputs,
    gen: {
      generate: async (kind, input) => {
        inputs.push({ kind, input });
        return inner.generate(kind, input);
      },
    },
  };
}

/** A judgment gateway that records every payload it is handed. */
function spyJudge(inner: JudgmentPort): { judge: JudgmentPort; payloads: unknown[] } {
  const payloads: unknown[] = [];
  return {
    payloads,
    judge: {
      systemOne: async (args) => {
        payloads.push(args);
        return inner.systemOne(args);
      },
    },
  };
}

async function goalRun(judge: JudgmentPort, gen: GenerationPort, goal: string, readOnly: boolean): Promise<ExploreRun> {
  return withSession(
    "secret-on-page-",
    async (session) => {
      const actor = CastActor.named("secret-on-page").whoCan(new BrowseTheWeb(session, [origin]));
      return explore({
        actor,
        judge,
        gen,
        goal,
        allowlist: [origin],
        startUrl: `${origin}/profile`,
        secrets: [SECRET],
        readOnly,
        bounds: { maxDecisions: 6 },
      });
    },
    origin,
  );
}

describe("#219 — a secret shown on the page is redacted before any model payload", () => {
  it(
    "perceive/snapshot and the page-text reader redact it at the source (control name, summary, value, href; visible text)",
    async () => {
      const seen = await withSession(
        "secret-on-page-perceive-",
        async (session) => {
          await session.page.goto(`${origin}/profile`);
          const p = await perceive(session.page, { secrets: [SECRET] });
          return { controls: p.snapshot.controls, hang: p.hang, text: await readPageText(session.page, [SECRET]) };
        },
        origin,
      );
      const email = seen.controls.find((c) => c.name === "Email");
      expect(email?.value).toBe(REDACTION_MASK);
      expect(email?.summary).toContain(`value="${REDACTION_MASK}"`);
      expect(seen.text).toContain(`Signed in as ${REDACTION_MASK}`);
      // Only the acting descriptor may hold page identifiers; nothing model-facing carries the value.
      expect(leaks(seen.controls.map(({ descriptor: _d, ...rest }) => rest))).toBe(false);
      expect(leaks(seen.text)).toBe(false);
    },
    60_000,
  );

  it(
    "goal find-out: completes; the page text and the field value reach the model redacted; the answer says it cannot disclose the secret",
    async () => {
      const scripted = new ScriptedJudge([{ op: "report" }]);
      const j = spyJudge(scripted);
      // The model "states" the secret (a plausible email that IS the registered one): scrubbed too.
      const g = spyGen(
        new FakeGenerationGateway({
          "goal.answer": {
            answer: `You are signed in as ${SECRET}.`,
            claims: [{ claim: `signed in as ${SECRET}`, quote: `Signed in as ${SECRET}`, absent: null }],
          },
        }),
      );
      const r = await goalRun(j.judge, g.gen, "Find out which email address this profile is signed in with.", true);

      expect(r.outcome).toEqual({ status: "completed", verifiedBy: "grounded-answer" });
      expect(r.answer?.withheld).toBe(true);
      expect(r.answer?.text).toContain(WITHHELD_ANSWER_NOTE);
      // The model DID see the page: its text (#207 visibleText) and the field, as the placeholder.
      const state = scripted.states[0]!;
      expect(state.visibleText).toContain(`Signed in as ${REDACTION_MASK}`);
      expect(state.controls.some((c) => c.includes(`value="${REDACTION_MASK}"`))).toBe(true);
      const answerInput = g.inputs.find((i) => (i as { kind: string }).kind === "goal.answer");
      expect(JSON.stringify(answerInput)).toContain(`Email: ${REDACTION_MASK}`);
      // …and never the value, anywhere.
      expect(g.inputs.length).toBeGreaterThan(0);
      expect(leaks(j.payloads)).toBe(false);
      expect(leaks(g.inputs)).toBe(false);
      expect(leaks(r.transcript)).toBe(false);
      expect(leaks(r.recording)).toBe(false);
      expect(leaks(r.answer)).toBe(false);
    },
    90_000,
  );

  it(
    "goal find-out: an answer quoting the redacted control value grounds on it (never on the secret) and is withheld",
    async () => {
      const j = spyJudge(new ScriptedJudge([{ op: "report" }]));
      const g = spyGen(
        new FakeGenerationGateway({
          "goal.answer": {
            answer: `The profile email is ${REDACTION_MASK}.`,
            claims: [{ claim: `the email is ${REDACTION_MASK}`, quote: `Email: ${REDACTION_MASK}`, absent: null }],
          },
        }),
      );
      const r = await goalRun(j.judge, g.gen, "Find out what email address the profile form holds.", true);
      expect(r.outcome).toEqual({ status: "completed", verifiedBy: "grounded-answer" });
      expect(r.answer?.withheld).toBe(true);
      expect(r.answer?.evidence[0]).toMatchObject({ grounded: true, source: "control-value", control: "Email" });
      expect(leaks(j.payloads)).toBe(false);
      expect(leaks(g.inputs)).toBe(false);
      expect(leaks(r.transcript)).toBe(false);
      expect(leaks(r.recording)).toBe(false);
    },
    90_000,
  );

  it(
    "goal: a typed value that equals the secret is recorded redacted — the run completes, no recording rejection",
    async () => {
      // Controls: [0] Reload profile (link), [1] Display name, [2] Email, [3] Save.
      const j = spyJudge(new ScriptedJudge([{ op: "type", target: "2" }, { op: "click", target: "3" }, { op: "done" }]));
      const g = spyGen(new FakeGenerationGateway({ "form.value": { text: SECRET } }));
      const r = await goalRun(j.judge, g.gen, "Save the profile form with an email address.", false);

      expect(r.failure).toBeUndefined();
      expect(r.outcome.status).toBe("completed");
      const fills = r.recording.pages.flatMap((p) => p.steps.map((s) => s.step)).filter((s) => s.kind === "fill");
      expect(fills.map((s) => (s.kind === "fill" ? s.value : null))).toEqual([{ redacted: true, length: SECRET.length }]);
      expect(leaks(j.payloads)).toBe(false);
      expect(leaks(g.inputs)).toBe(false);
      expect(leaks(r.transcript)).toBe(false);
      expect(leaks(r.recording)).toBe(false);
    },
    90_000,
  );

  it(
    "adversarial: completes (not crashed) on a page showing the secret, even when its own valid email equals it",
    async () => {
      const j = spyJudge(new FakeJudgmentGateway({ looksBroken: { kind: "noul", value: false, probability: 0.1 } }));
      const g = spyGen(new FakeGenerationGateway());
      const result = await withSession(
        "secret-on-page-adv-",
        async (session) => {
          const actor = CastActor.named("adversary").whoCan(new BrowseTheWeb(session, [origin]));
          return runAdversarialMission({
            page: session.page,
            actor,
            judgment: j.judge,
            generation: g.gen,
            seedUrl: `${origin}/profile`,
            allowlist: [origin],
            secrets: [SECRET],
            strategies: ["boundary-input", "boundary-submit", "double-submit"],
            bounds: { maxDecisions: 8 },
          });
        },
        origin,
      );

      expect(result.outcome).not.toBe("crashed");
      expect(result.failure).toBeUndefined();
      expect(result.recording.pages.length).toBeGreaterThan(0);
      expect(j.payloads.length + g.inputs.length).toBeGreaterThan(0);
      expect(leaks(j.payloads)).toBe(false);
      expect(leaks(g.inputs)).toBe(false);
      expect(leaks(result.transcript)).toBe(false);
      expect(leaks(result.recording)).toBe(false);
      expect(leaks(result)).toBe(false);
    },
    120_000,
  );
});
