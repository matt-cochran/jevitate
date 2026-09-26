import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeGenerationGateway, FakeJudgmentGateway } from "@jevitate/ai-core";
import { BrowseTheWeb, CastActor } from "@jevitate/screenplay";
import { runAdversarialMission, type AdversarialOutcome } from "./adversarial.js";
import type { MisuseStrategy } from "../adversarial/misuse.js";
import { DEFAULT_COVERAGE_THRESHOLDS } from "../adversarial/run-coverage.js";
import { withSession } from "../testkit.js";

/**
 * #193 — dogfood repro: a Phone Numbers tool whose ONLY form lives in a modal ("Add New Phone
 * Number" opens a dialog: a country-code select with 250+ options, a phone field, Cancel/Save),
 * next to a global header whose "Open user menu" reveals a menu of links (no form), and ~40 plain
 * in-scope controls. The run found the modal's form but never submitted it, re-opened the header
 * menu as "a place to look for a form", and reported "strategy found no applicable action" while
 * most controls were still unexercised.
 */

const state = { phonePosts: 0 };

const COUNTRIES = Array.from({ length: 260 }, (_, i) => `<option value="+${i + 1}">Country ${i + 1} (+${i + 1})</option>`).join("");

const plainControls = (): string => {
  const out: string[] = [];
  for (let i = 1; i <= 10; i++) out.push(`<label><input type="checkbox" aria-label="Show column ${i}" /> Column ${i}</label>`);
  for (let i = 1; i <= 10; i++) out.push(`<button type="button" class="sort">Sort by field ${i}</button>`);
  for (let i = 1; i <= 10; i++) out.push(`<button type="button" class="copy">Copy number ${i}</button>`);
  for (let i = 1; i <= 10; i++) out.push(`<button type="button" class="pin" aria-pressed="false">Pin row ${i}</button>`);
  return out.join("\n");
};

const PHONES = (): string => `<!doctype html><html><head><style>
  #overlay { position: fixed; inset: 0; background: rgba(0,0,0,.4); display: none; z-index: 10; }
  #add-phone { position: fixed; top: 20px; left: 20px; right: 20px; background: #fff; padding: 12px; display: none; z-index: 11; }
  #user-menu { display: none; }
  .open { display: block !important; }
</style></head><body>
  <header>
    <a href="/app/phones">Autopilot</a>
    <button id="userBtn" aria-label="Open user menu" aria-haspopup="menu" aria-expanded="false">U</button>
    <div id="user-menu" role="menu">
      <a role="menuitem" href="/home">Navigate to home</a>
      <a role="menuitem" href="/account">Account settings</a>
      <a role="menuitem" href="/help">Help center</a>
    </div>
  </header>
  <main>
    <h1>Phone Numbers</h1>
    <button id="addBtn" aria-haspopup="dialog">Add New Phone Number</button>
    <button id="buyBtn">Purchase number</button>
    <div id="controls">${plainControls()}</div>
    <div id="toast" role="status"></div>
  </main>
  <div id="overlay"></div>
  <div id="add-phone" role="dialog" aria-modal="true" aria-label="Add New Phone Number">
    <h2>Add New Phone Number</h2>
    <label>Country code <select aria-label="Country code">${COUNTRIES}</select></label>
    <label>Phone Number <input type="tel" aria-label="Phone Number" /></label>
    <button type="button" id="cancelBtn">Cancel</button>
    <button type="button" id="saveBtn">Save</button>
  </div>
  <script>
    const menu = document.getElementById('user-menu');
    const userBtn = document.getElementById('userBtn');
    userBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const open = !menu.classList.contains('open');
      menu.classList.toggle('open', open);
      userBtn.setAttribute('aria-expanded', String(open));
    });
    document.addEventListener('click', (e) => {
      if (!menu.contains(e.target)) { menu.classList.remove('open'); userBtn.setAttribute('aria-expanded', 'false'); }
    });
    const dialog = document.getElementById('add-phone');
    const overlay = document.getElementById('overlay');
    const show = (v) => { dialog.classList.toggle('open', v); overlay.classList.toggle('open', v); };
    document.getElementById('addBtn').addEventListener('click', () => show(true));
    document.getElementById('cancelBtn').addEventListener('click', () => show(false));
    document.getElementById('saveBtn').addEventListener('click', async () => {
      const phone = dialog.querySelector('input').value;
      const code = dialog.querySelector('select').value;
      await fetch('/api/phone-numbers', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, phone }) });
      show(false);
      document.getElementById('toast').textContent = 'Phone number added';
    });
    document.getElementById('buyBtn').addEventListener('click', async () => { await fetch('/api/purchase', { method: 'POST' }); });
    for (const b of document.querySelectorAll('.sort, .copy')) b.addEventListener('click', () => { document.getElementById('toast').textContent = b.textContent; });
    for (const b of document.querySelectorAll('.pin')) b.addEventListener('click', () => b.setAttribute('aria-pressed', String(b.getAttribute('aria-pressed') !== 'true')));
  </script>
</body></html>`;

const OTHER = (title: string): string => `<!doctype html><html><body><h1>${title}</h1><a href="/app/phones">Phone numbers</a></body></html>`;

let server: Server;
let origin: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0] ?? "";
    if (path === "/api/phone-numbers" && req.method === "POST") {
      state.phonePosts += 1;
      res.writeHead(201, { "content-type": "application/json" }).end("{}");
      return;
    }
    if (path === "/api/purchase") {
      res.writeHead(500).end();
      return;
    }
    if (path === "/app/phones") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(PHONES());
      return;
    }
    if (path === "/home" || path === "/account" || path === "/help") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(OTHER(path.slice(1)));
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

/** The CLI's `--strategy adversarial` order (`CLI_ADVERSARIAL_STRATEGIES` in @jevitate/cli). */
const CLI_STRATEGIES: readonly MisuseStrategy[] = [
  "double-submit",
  "boundary-submit",
  "edit-cancel-save",
  "navigate-away-unsaved",
  "act-while-pending",
  "exercise-controls",
  "ordering-violation",
  "repeat-rapid",
  "boundary-input",
  "contradictory-actions",
  "nav-during-pending",
  "visit-route",
];

async function hunt(): Promise<AdversarialOutcome> {
  return withSession(
    "adv-193-",
    async (session) => {
      const actor = CastActor.named("adversary").whoCan(new BrowseTheWeb(session, [origin]));
      return runAdversarialMission({
        page: session.page,
        actor,
        judgment: new FakeJudgmentGateway({ looksBroken: { kind: "noul", value: false, probability: 0.1 } }),
        generation: new FakeGenerationGateway(),
        seedUrl: `${origin}/app/phones`,
        allowlist: [origin],
        strategies: CLI_STRATEGIES,
        bounds: { maxActions: 60 },
        safety: { deny: ["Purchase"] },
      });
    },
    origin,
  );
}

describe("adversarial — a modal-only form beside a header menu (#193)", () => {
  it(
    "submits the modal form, opens the header menu at most once, and never idles while controls remain",
    async () => {
      state.phonePosts = 0;
      const result = await hunt();
      const t = result.transcript;
      expect(result.outcome).not.toBe("crashed");

      // 1. The modal's form is driven to a submit that reaches the server.
      expect(result.coverage.forms.found).toBeGreaterThanOrEqual(1);
      expect(result.coverage.forms.submitted).toBeGreaterThanOrEqual(1);
      expect(state.phonePosts).toBeGreaterThanOrEqual(1);

      // 2. The global header's user menu is opened as "a place to look for a form" at most once.
      const menuDisclosures = t.filter(
        (e) => e.op === "click" && e.target?.includes("Open user menu") === true && e.reason?.includes("to look for a form") === true,
      );
      expect(menuDisclosures.length).toBeLessThanOrEqual(1);

      // 3. Never "no applicable action" while unexercised in-scope controls remain: a strategy with
      // nothing of its own to do exercises a control instead. When the run does idle, the only
      // controls left unexercised are ones it could not act on (refused as not actionable).
      const firstIdle = t.findIndex((e) => e.reason?.includes("strategy found no applicable action") === true);
      if (firstIdle >= 0) {
        const unactionable = new Set(
          t.filter((e) => !e.actOk && /timeout|not actionable|no longer present/i.test(e.reason ?? "")).map((e) => e.target),
        );
        expect(result.coverage.controls.total - result.coverage.controls.exercised).toBeLessThanOrEqual(unactionable.size);
      }
      // The non-form strategies that found nothing of their own exercised controls instead.
      expect(t.some((e) => e.reason?.startsWith("no ordering-violation action applies") === true)).toBe(true);

      // 4. Coverage reaches the default threshold.
      expect(result.coverage.controls.ratio).toBeGreaterThanOrEqual(DEFAULT_COVERAGE_THRESHOLDS.minControlRatio);
      expect(result.coverage.sufficient).toBe(true);
    },
    300_000,
  );
});
