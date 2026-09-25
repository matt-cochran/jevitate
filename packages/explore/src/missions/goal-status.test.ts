import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeGenerationGateway } from "@jevitate/ai-core";
import { BrowseTheWeb, CastActor } from "@jevitate/screenplay";
import { runGoalBasedMission, type GoalBasedResult, type SuccessWhen } from "./goal-based.js";
import { MAX_QUIET_WAITS } from "../explore.js";
import type { SuccessCheck } from "../success-checks.js";
import { ScriptedJudge, withSession, type ScriptedStep } from "../testkit.js";

/**
 * #79 / #80 / #84 — the goal loop reads the page's status text, stops waiting on a page where
 * nothing is pending, remembers a success state it passed through (opt-in), and names the concrete
 * blocker in its reason. Static pages from the issues' minimal repros, served; scripted judges only.
 */

const PAGES: Record<string, string> = {
  // #79: a submit that only reveals an inline alert.
  "/alert": `<!doctype html><html><body><h1>New brand kit</h1>
    <form onsubmit="event.preventDefault(); document.getElementById('err').hidden = false">
      <input name="t" aria-label="Title" /><button>Create</button>
      <p id="err" role="alert" hidden>Enter a brand kit name.</p>
    </form></body></html>`,
  // #79 / #84: a disabled target whose name says why.
  "/disabled": `<!doctype html><html><body><h1>Import</h1>
    <input aria-label="Site URL" /><button type="button" disabled>Analyze — enter a URL first</button>
    </body></html>`,
  // #80: a one-time secret the run then dismisses.
  "/secret": `<!doctype html><html><body><h1>API keys</h1>
    <button type="button" onclick="document.getElementById('ok').hidden = false">Create</button>
    <div id="ok" hidden data-testid="secret">SECRET-abc123
      <button type="button" onclick="document.getElementById('ok').hidden = true">Done</button></div>
    </body></html>`,
  // #84: the value generator will not supply the Email.
  "/email": `<!doctype html><html><body><h1>Sign up</h1>
    <form onsubmit="event.preventDefault(); document.getElementById('echo').textContent = this.e.value">
      <input name="e" type="email" aria-label="Email" /><button>Sign up</button></form>
    <p data-testid="echo"></p></body></html>`,
  // #84: an HTML5-invalid field blocks the submit. A `pattern` constraint (not type=email): the typed
  // value passes the pre-type value check (#71) — only the browser's own validation rejects it.
  "/invalid": `<!doctype html><html><body><h1>Sign up</h1>
    <form onsubmit="event.preventDefault(); document.getElementById('echo').textContent = 'welcome'">
      <input name="e" type="text" pattern="[^ ]+@[^ ]+" aria-label="Email" /><button>Sign up</button></form>
    <p data-testid="echo"></p></body></html>`,
  // #130a: an UNRELATED field (Phone) sits natively invalid the whole time — never touched by the
  // run — while Save (Last name's own control) sends a real request. The invalid Phone must never be
  // blamed for a success check that expected a different method (#130b's near-miss hint fires here).
  "/mixed": `<!doctype html><html><body><h1>Profile</h1>
    <input value="12x" pattern="[0-9]{10}" aria-label="Phone" />
    <label>Last name <input aria-label="Last name" /></label>
    <button type="button" id="save">Save</button>
    <script>
      document.getElementById('save').addEventListener('click', () => { fetch('/api/save', { method: 'POST' }); });
    </script></body></html>`,
  // #174: the check's testid is on the page from the start (a placeholder receipt).
  "/placeholder": `<!doctype html><html><body><h1>Bet</h1>
    <div id="v" data-testid="verdict">Verdict: pending</div>
    <button type="button">Recalculate</button>
    <button type="button" onclick="document.getElementById('v').hidden = true">Clear verdict</button>
    <button type="button" onclick="const v = document.getElementById('v'); v.textContent = 'Verdict: go ahead'; v.hidden = false">Show verdict</button>
    </body></html>`,
  // #174: after Verify the goal is met; "Create product" is a write the goal never asked for.
  "/verify": `<!doctype html><html><body><h1>Sign in</h1>
    <button type="button" id="verify">Verify</button>
    <div id="onb" hidden><p data-testid="onboarding">Welcome — set up your first product</p>
      <button type="button" id="product">Create product</button></div>
    <script>
      document.getElementById('verify').addEventListener('click', () => { document.getElementById('onb').hidden = false; });
      document.getElementById('product').addEventListener('click', () => { fetch('/api/product', { method: 'POST' }); });
    </script></body></html>`,
};

let server: Server;
let origin: string;
/** #174: POSTs to /api/product (an unrequested write) and to /api/save. */
let writes = 0;
let saves = 0;

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.method === "POST" && req.url === "/api/product") {
      writes += 1;
      res.writeHead(200, { "content-type": "application/json" }).end("{}");
      return;
    }
    if (req.method === "POST" && req.url === "/api/save") {
      saves += 1;
      res.writeHead(200, { "content-type": "application/json" }).end("{}");
      return;
    }
    const body = PAGES[(req.url ?? "").split("?")[0] ?? ""];
    if (body === undefined) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (addr === null || typeof addr === "string") throw new Error("server has no port");
  origin = `http://127.0.0.1:${(addr satisfies AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const visible = (testId: string): SuccessCheck => ({ kind: "page", assertion: { kind: "visible", target: { testId } } });

async function run(
  path: string,
  steps: ScriptedStep[],
  checks: SuccessCheck[],
  opts: { value?: string | null; successWhen?: SuccessWhen; maxDecisions?: number } = {},
): Promise<{ result: GoalBasedResult; judge: ScriptedJudge }> {
  const judge = new ScriptedJudge(steps);
  const result = await withSession(
    "goal-status-",
    async (session) => {
      const actor = CastActor.named("status").whoCan(new BrowseTheWeb(session, [origin]));
      return runGoalBasedMission({
        actor,
        judge,
        gen: new FakeGenerationGateway({ "form.value": { text: opts.value === undefined ? "Jevitate site" : opts.value } }),
        goal: "create it",
        allowlist: [origin],
        startUrl: `${origin}${path}`,
        successChecks: checks,
        oracleTimeoutMs: 300,
        waitOpMs: 300,
        bounds: { maxDecisions: opts.maxDecisions ?? 40 },
        ...(opts.successWhen === undefined ? {} : { successWhen: opts.successWhen }),
      });
    },
    origin,
  );
  return { result, judge };
}

describe("goal loop — status text, quiet waits, held success, concrete reasons (#79 #80 #84)", () => {
  it(
    "#79: an alert that appears after submit reaches the model, and the loop stops on it instead of waiting",
    async () => {
      // Controls: [0] Title, [1] Create. Click Create (empty title), then the model only waits.
      const { result, judge } = await run("/alert", [{ op: "click", target: "1" }, { op: "wait" }], [visible("created")]);

      const history = judge.states.at(-1)?.history ?? [];
      expect(history).toContain('after click Create: alert "Enter a brand kit name."');
      expect(judge.states.at(-1)?.controls.some((l) => l.includes('PAGE STATUS') && l.includes("Enter a brand kit name."))).toBe(true);
      const waits = result.transcript.filter((e) => e.op === "wait").length;
      expect(waits).toBe(MAX_QUIET_WAITS);
      expect(result.outcome).toBe("blocked");
      expect(result.run.outcome.status === "incomplete" && result.run.outcome.reason).toBe(
        'stuck: the page shows alert "Enter a brand kit name."',
      );
      expect(result.reason).toMatch(/^stuck: the page shows alert "Enter a brand kit name\."; success check failed/);
    },
    120_000,
  );

  it(
    "#79 / #84: a disabled target is named in history and in the stop reason",
    async () => {
      // Controls: [0] Site URL, [1] Analyze (disabled).
      const { result, judge } = await run("/disabled", [{ op: "click", target: "1" }, { op: "wait" }], [visible("report")]);

      const history = judge.states.at(-1)?.history ?? [];
      expect(history.some((h) => h.includes('target not enabled: "Analyze — enter a URL first" is disabled'))).toBe(true);
      expect(result.transcript[0]?.reason).toContain('"Analyze — enter a URL first"');
      expect(result.run.blockingCause).toBe('target disabled — "Analyze — enter a URL first"');
      expect(result.reason).toMatch(/^stuck: target disabled — "Analyze — enter a URL first"/);
    },
    120_000,
  );

  it(
    "#80: a one-time secret dismissed before `done` fails by default and succeeds with successWhen=held",
    async () => {
      // Controls: [0] Create; after it, [1] Done (closes the secret).
      const steps: ScriptedStep[] = [{ op: "click", target: "0" }, { op: "click", target: "1" }, { op: "done" }];

      const final = await run("/secret", steps, [visible("secret")]);
      expect(final.result.outcome).not.toBe("succeeded");
      expect(final.result.assertionPassed).toBe(false);

      const held = await run("/secret", steps, [visible("secret")], { successWhen: "held" });
      expect(held.result.outcome).toBe("succeeded");
      expect(held.result.run.stop).toBe("done");
      expect(held.result.checks[0]?.passed).toBe(true);
      // #174: once the held check held (settled step 2, after Create), the run stopped — it never
      // went on to dismiss the secret, so the check also holds on the final page.
      const last = held.result.transcript.at(-1);
      expect(last?.strategy).toBe("success-held");
      expect(last?.reason).toMatch(/goal already met — stopped before the next action: every --success check held \(the page checks at settled step 2/);
      expect(held.result.transcript.filter((e) => e.op === "click").length).toBe(1);
      expect(held.result.run.outcome).toEqual({ status: "completed", verifiedBy: "success-condition" });
    },
    120_000,
  );

  it(
    "#80: successWhen=held never passes a check that never held",
    async () => {
      const { result } = await run("/secret", [{ op: "done" }], [visible("secret")], { successWhen: "held" });
      expect(result.outcome).toBe("blocked");
      expect(result.assertionPassed).toBe(false);
    },
    120_000,
  );

  it(
    "#84: a fail-closed value step is named in the reason (field + why)",
    async () => {
      // Controls: [0] Email, [1] Sign up. The generator returns no value for Email.
      const { result } = await run("/email", [{ op: "type", target: "0" }], [visible("echo")], { value: null });
      expect(result.outcome).toBe("blocked");
      expect(result.reason).toMatch(/^blocked: no value for field "Email" \(the value generator returned none\)/);
    },
    120_000,
  );

  it(
    "#84: an HTML5-invalid field's validationMessage is the reason when the model gives up",
    async () => {
      // Type a non-email into Email, click Sign up (the browser refuses), then the model reports blocked.
      const { result, judge } = await run(
        "/invalid",
        [{ op: "type", target: "0" }, { op: "click", target: "1" }, { op: "blocked" }],
        [{ kind: "page", assertion: { kind: "textIncludes", target: { testId: "echo" }, text: "welcome" } }],
        { value: "not an email" },
      );
      expect(judge.states.at(-1)?.history.some((h) => /invalid field "Email": ".+"/.test(h))).toBe(true);
      expect(result.outcome).toBe("blocked");
      expect(result.reason).toMatch(
        /^the model reported the goal cannot be advanced from this page — last blocker: field "Email" is invalid — ".+"/,
      );
    },
    120_000,
  );

  it(
    "#130a/#130b: an unrelated invalid field is never blamed when the last submit DID send a request — the network check's near-miss hint carries the reason instead",
    async () => {
      // Controls: [0] Phone (natively invalid the whole time, never touched), [1] Last name, [2] Save.
      const { result } = await run(
        "/mixed",
        [{ op: "type", target: "1" }, { op: "click", target: "2" }, { op: "wait" }],
        [{ kind: "requestMade", method: "PUT", pathGlob: "/api/save" }],
      );
      expect(result.outcome).not.toBe("succeeded");
      // Never blamed on the unrelated Phone field: the save DID send a request (just the wrong method).
      expect(result.run.blockingCause).toBeUndefined();
      expect(result.reason).not.toContain("Phone");
      expect(result.reason).not.toContain("last blocker");
      // The near-miss hint (#130b) names what actually happened instead.
      expect(result.reason).toContain("saw POST /api/save → 200 (1×)");
    },
    120_000,
  );
});

describe("#174 — --success-when held: never vacuous on the start page; stop once every check held", () => {
  it(
    "a held check that already holds on the start page (a placeholder) is vacuous: not succeeded, with a warning",
    async () => {
      // Controls: [0] Recalculate (does nothing the check can see).
      const { result } = await run("/placeholder", [{ op: "click", target: "0" }, { op: "done" }], [visible("verdict")], {
        successWhen: "held",
        maxDecisions: 6,
      });
      expect(result.outcome).not.toBe("succeeded");
      expect(result.assertionPassed).toBe(false);
      expect(result.checks[0]?.passed).toBe(false);
      expect(result.checks[0]?.detail).toMatch(/^vacuous: already held on the start page before any action/);
      expect(result.warnings?.[0]).toMatch(/already held on the start page, before any action, and never changed — vacuous/);
      // The in-run `done` was not accepted on the vacuous check either.
      expect(result.transcript.some((e) => e.op === "done" && /done rejected/.test(e.reason ?? ""))).toBe(true);
      expect(result.run.outcome.status).toBe("incomplete");
    },
    120_000,
  );

  it(
    "a check that held on the start page counts once it went from not holding to holding (with a warning)",
    async () => {
      // Controls: [0] Recalculate, [1] Clear verdict (hides it), [2] Show verdict (shows the real one).
      const { result } = await run("/placeholder", [{ op: "click", target: "1" }, { op: "click", target: "2" }], [visible("verdict")], {
        successWhen: "held",
      });
      expect(result.outcome).toBe("succeeded");
      expect(result.warnings?.[0]).toMatch(/counted only once they went from not holding to holding/);
    },
    120_000,
  );

  it(
    "once every held check held, the run stops before its next action — it never goes on to write",
    async () => {
      writes = 0;
      // Controls: [0] Verify; after it, [1] Create product (a write the goal did not ask for).
      const { result } = await run("/verify", [{ op: "click", target: "0" }, { op: "click", target: "1" }, { op: "done" }], [visible("onboarding")], {
        successWhen: "held",
      });
      expect(result.outcome).toBe("succeeded");
      expect(result.run.stop).toBe("done");
      expect(writes).toBe(0);
      expect(result.transcript.filter((e) => e.op === "click").length).toBe(1);
      expect(result.transcript.at(-1)?.strategy).toBe("success-held");
    },
    120_000,
  );

  it(
    "a network-only held check stops the run once the request was seen — no `done` needed, no second write",
    async () => {
      saves = 0;
      // Controls: [0] Phone, [1] Last name, [2] Save.
      const { result } = await run(
        "/mixed",
        [{ op: "click", target: "2" }, { op: "click", target: "2" }, { op: "click", target: "2" }],
        [{ kind: "responseStatus", method: "POST", pathGlob: "/api/save", status: { class: 2 } }],
        { successWhen: "held" },
      );
      expect(result.outcome).toBe("succeeded");
      expect(saves).toBe(1);
      expect(result.transcript.at(-1)?.strategy).toBe("success-held");
    },
    120_000,
  );
});
