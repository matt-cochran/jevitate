import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeGenerationGateway, FakeJudgmentGateway } from "@jevitate/ai-core";
import { BrowseTheWeb, CastActor } from "@jevitate/screenplay";
import { runAdversarialMission, type AdversarialMissionParams, type AdversarialOutcome } from "./adversarial.js";
import type { MisuseStrategy } from "../adversarial/misuse.js";
import { withSession } from "../testkit.js";

/**
 * #121 — dogfood repro: a header search wrongly paired with an unrelated "Send feedback", text
 * typed into `input[type=number]` (never adapting), forms missed behind a widened disclosure, and a
 * chat composer never exercised (the run instead clicked "+New …" repeatedly). Served fixtures
 * modelled on the issue's `/settings` page and `/workspace?inquiry=…` chat.
 */

const state = { feedbacks: 0, spendSaves: 0, planConfirms: 0, messages: 0 };

const SETTINGS = (): string => `<!doctype html><html><body>
  <header>
    <input type="search" aria-label="Semantic search" />
  </header>
  <main>
    <section id="feedback-section">
      <h2>Feedback</h2>
      <textarea aria-label="Your feedback"></textarea>
      <button id="feedbackBtn" disabled>Send feedback</button>
    </section>

    <section id="spend-section">
      <h2>Spend cap</h2>
      <input type="number" aria-label="Spend cap in credits / 30 days" min="0" max="1000" step="1" value="100" />
      <button id="spendSave">Save</button>
    </section>

    <button id="opener" onclick="document.getElementById('d').showModal()">Review this plan</button>
    <dialog id="d">
      <form method="dialog" id="planform">
        <label>Note <input aria-label="Note" /></label>
        <button id="planConfirm">Confirm</button>
      </form>
    </dialog>
  </main>
  <div id="toast" role="status"></div>
  <script>
    const fb = document.querySelector('#feedback-section textarea');
    const fbBtn = document.getElementById('feedbackBtn');
    fb.addEventListener('input', () => { fbBtn.disabled = fb.value.trim() === ''; });
    fbBtn.addEventListener('click', async () => {
      await fetch('/api/feedback', { method: 'POST' });
      document.getElementById('toast').textContent = 'Feedback sent';
    });
    document.getElementById('spendSave').addEventListener('click', async () => {
      await fetch('/api/spend', { method: 'POST' });
    });
    document.getElementById('planform').addEventListener('submit', async () => {
      await fetch('/api/plan', { method: 'POST' });
    });
  </script>
</body></html>`;

const WORKSPACE = (): string => `<!doctype html><html><body>
  <h1>Inquiry: Raise pro</h1>
  <div id="thread"></div>
  <textarea aria-label="Type a reply"></textarea>
  <button id="sendBtn">Send</button>
  <button id="newInquiry">+New inquiry</button>
  <script>
    document.getElementById('sendBtn').addEventListener('click', async () => {
      const ta = document.querySelector('textarea');
      const msg = ta.value;
      ta.value = '';
      const div = document.createElement('div');
      div.textContent = 'You said: ' + msg;
      document.getElementById('thread').appendChild(div);
      await fetch('/api/messages', { method: 'POST' });
    });
  </script>
</body></html>`;

let server: Server;
let origin: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0] ?? "";
    if (path === "/api/feedback" && req.method === "POST") {
      state.feedbacks += 1;
      res.writeHead(200, { "content-type": "application/json" }).end("{}");
      return;
    }
    if (path === "/api/spend" && req.method === "POST") {
      state.spendSaves += 1;
      res.writeHead(200, { "content-type": "application/json" }).end("{}");
      return;
    }
    if (path === "/api/plan" && req.method === "POST") {
      state.planConfirms += 1;
      res.writeHead(200, { "content-type": "application/json" }).end("{}");
      return;
    }
    if (path === "/api/messages" && req.method === "POST") {
      state.messages += 1;
      res.writeHead(200, { "content-type": "application/json" }).end("{}");
      return;
    }
    if (path === "/app/settings") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(SETTINGS());
      return;
    }
    if (path === "/app/workspace") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(WORKSPACE());
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (addr === null || typeof addr === "string") throw new Error("server has no port");
  origin = `http://127.0.0.1:${(addr satisfies AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function hunt(
  seedPath: string,
  strategies: readonly MisuseStrategy[],
  extra: Partial<AdversarialMissionParams> = {},
): Promise<AdversarialOutcome> {
  return withSession(
    "adv-121-",
    async (session) => {
      const actor = CastActor.named("adversary").whoCan(new BrowseTheWeb(session, [origin]));
      return runAdversarialMission({
        page: session.page,
        actor,
        judgment: new FakeJudgmentGateway({ looksBroken: { kind: "noul", value: false, probability: 0.1 } }),
        generation: new FakeGenerationGateway(),
        seedUrl: `${origin}${seedPath}`,
        allowlist: [origin],
        strategies,
        ...extra,
      });
    },
    origin,
  );
}

const FULL_FORM_STRATEGIES: readonly MisuseStrategy[] = [
  "double-submit",
  "boundary-submit",
  "edit-cancel-save",
  "navigate-away-unsaved",
  "act-while-pending",
  "exercise-controls",
];

describe("adversarial — settings page: field/submit pairing, numeric boundaries, widened disclosure (#121)", () => {
  it(
    "never pairs the header search with the unrelated Send feedback button",
    async () => {
      state.feedbacks = 0;
      const result = await hunt("/app/settings", FULL_FORM_STRATEGIES, { bounds: { maxDecisions: 20, maxActions: 40 } });
      expect(result.outcome).not.toBe("crashed");

      // Every submit click of "Send feedback" is recorded against the feedback form's OWN key
      // (the section container), never a generic "page" bucket that could also hold the search box.
      const feedbackSubmits = result.transcript.filter((e) => e.target?.includes('"Send feedback"') === true && e.actOk);
      expect(feedbackSubmits.length).toBeGreaterThan(0);

      // The header search is never followed immediately by a "Send feedback" click in the same
      // episode/step pair the way the dogfood repro did (double-submit editing search then "submitting"
      // an unrelated disabled button that never fires).
      const searchSteps = result.transcript.filter((e) => e.target?.includes('"Semantic search"') === true);
      for (const s of searchSteps) {
        expect(s.reason ?? "").not.toContain("Send feedback");
      }

      // The feedback form really got submitted server-side (never a no-op on a disabled control).
      expect(state.feedbacks).toBeGreaterThan(0);
    },
    180_000,
  );

  it(
    "the spend-cap number field always gets a numeric value, never text (no repeated fill errors)",
    async () => {
      const result = await hunt("/app/settings", ["boundary-submit"], { bounds: { maxDecisions: 12 } });
      expect(result.outcome).not.toBe("crashed");

      const spendSteps = result.transcript.filter((e) => e.target?.includes("Spend cap") === true);
      expect(spendSteps.length).toBeGreaterThan(0);

      // Every typed value into the spinbutton parses as a number (or is the empty string).
      const fills = result.recording.pages
        .flatMap((p) => p.steps.map((s) => s.step))
        .filter((s) => s.kind === "fill" && JSON.stringify(s.target).includes("Spend cap"));
      expect(fills.length).toBeGreaterThan(0);
      for (const f of fills) {
        const v = typeof f.value === "string" ? f.value : "";
        expect(v === "" || Number.isFinite(Number(v))).toBe(true);
      }

      // Never the exact failure the issue reports, and never repeated without adapting.
      const fillErrors = result.transcript.filter((e) => (e.reason ?? "").includes("Cannot type text into input[type=number]"));
      expect(fillErrors).toEqual([]);
    },
    180_000,
  );

  it(
    "widened disclosure matching opens 'Review this plan' and its form is found and submitted",
    async () => {
      state.planConfirms = 0;
      const result = await hunt("/app/settings", FULL_FORM_STRATEGIES, { bounds: { maxDecisions: 20, maxActions: 40 } });
      expect(result.outcome).not.toBe("crashed");

      const opened = result.transcript.some((e) => e.target?.includes('"Review this plan"') === true && e.actOk);
      expect(opened).toBe(true);
      expect(state.planConfirms).toBeGreaterThan(0);
    },
    180_000,
  );

  it(
    "all three forms on the page (feedback, spend cap, the disclosed plan) are found and each submitted at least once",
    async () => {
      state.feedbacks = 0;
      state.spendSaves = 0;
      state.planConfirms = 0;
      const result = await hunt("/app/settings", FULL_FORM_STRATEGIES, { bounds: { maxDecisions: 30, maxActions: 60 } });
      expect(result.outcome).not.toBe("crashed");

      expect(result.coverage.forms.found).toBeGreaterThanOrEqual(3);
      expect(result.coverage.forms.submitted).toBeGreaterThanOrEqual(3);
      expect(state.feedbacks).toBeGreaterThan(0);
      expect(state.spendSaves).toBeGreaterThan(0);
      expect(state.planConfirms).toBeGreaterThan(0);
    },
    180_000,
  );
});

describe("adversarial — chat composer is treated as a form and exercised (#121)", () => {
  it(
    "types a misuse value into the composer and sends it, preferring it over repeatedly opening '+New inquiry'",
    async () => {
      state.messages = 0;
      const result = await hunt("/app/workspace", ["boundary-submit", "double-submit"], { bounds: { maxDecisions: 8 } });
      expect(result.outcome).not.toBe("crashed");

      const sends = result.transcript.filter((e) => e.op === "send" && e.actOk);
      expect(sends.length).toBeGreaterThan(0);
      expect(sends.every((e) => e.target?.includes("Type a reply") === true)).toBe(true);

      // The composer's own send really reached the server.
      expect(state.messages).toBeGreaterThan(0);

      // "+New inquiry" is a disclosure-name match too, but the composer is found first: it is never
      // opened while the composer still has unexercised misuse rounds to run.
      const newInquiryOpens = result.transcript.filter((e) => e.target?.includes("+New inquiry") === true && e.actOk);
      expect(newInquiryOpens).toEqual([]);
    },
    180_000,
  );

  it(
    "counts the composer as a found-and-submitted form in coverage",
    async () => {
      const result = await hunt("/app/workspace", ["boundary-submit"], { bounds: { maxDecisions: 4 } });
      expect(result.outcome).not.toBe("crashed");
      expect(result.coverage.forms.found).toBeGreaterThanOrEqual(1);
      expect(result.coverage.forms.submitted).toBeGreaterThanOrEqual(1);
    },
    180_000,
  );
});
