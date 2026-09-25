import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeGenerationGateway, FakeJudgmentGateway } from "@jevitate/ai-core";
import { PlaywrightBrowserPort } from "@jevitate/playwright";
import { BrowseTheWeb, CastActor } from "@jevitate/screenplay";
import type { VerifySession } from "../verify-fix.js";
import { runAdversarialMission, type AdversarialMissionParams, type AdversarialOutcome } from "./adversarial.js";
import type { MisuseStrategy } from "../adversarial/misuse.js";
import { withSession } from "../testkit.js";

/**
 * #64 — adversarial coverage on an ordinary form. A served profile page (text fields, a select,
 * Cancel and Save; Save PUTs to the API after a short delay, then shows a toast) must get
 * submit-centred misuse: double submits, boundary submits, edit→cancel→save, leaving with unsaved
 * edits, and acting while the save is still pending.
 */

const state = { puts: 0, lastName: "Lovelace", keySubmits: 0, signups: 0, nativeSignins: 0 };

/**
 * #155 — the issue's minimal repro: a submit button that native validation blocks (`required`
 * email + a `required minlength=8` password). Its own `onsubmit` handler (the one that would POST)
 * only runs when the browser's OWN constraint validation passes first — exactly the real-world
 * case where a submit click never reaches the server.
 */
const NATIVE_VALIDATION_FORM = (): string => `<!doctype html><html><body><h1>Sign in</h1>
  <form id="signin" onsubmit="event.preventDefault(); fetch('/api/signin-native', { method: 'POST' });">
    <label>Email <input type="email" name="email" required aria-label="Email" /></label>
    <label>Password <input type="password" name="password" required minlength="8" aria-label="Password" /></label>
    <button type="submit" id="submit">Sign In</button>
  </form>
</body></html>`;

/**
 * #76 — the issue's minimal repro: a form behind a modal trigger (an API-keys page: "Create new
 * key" opens a dialog with a Name field and a Create button) alongside an always-visible signup
 * form whose submit is disabled until its `type=password` field is filled too. Both must be found
 * AND submitted by the adversarial frontier.
 */
const KEYS_AND_SIGNUP = (): string => `<!doctype html><html><body>
  <h1>Settings</h1>
  <button id="opener" onclick="document.getElementById('d').showModal()">Create new key</button>
  <dialog id="d">
    <form method="dialog" id="keyform">
      <label>Name <input required name="n" aria-label="Name" /></label>
      <button id="createKey">Create</button>
    </form>
  </dialog>
  <form id="signup">
    <label>Email <input type="email" required aria-label="Email" /></label>
    <label>Password <input type="password" required minlength="8" aria-label="Password" /></label>
    <button id="signupBtn" disabled>Sign up</button>
  </form>
  <div id="toast" role="status"></div>
  <script>
    const form = document.getElementById("signup");
    const btn = document.getElementById("signupBtn");
    function refresh() { btn.disabled = !form.checkValidity(); }
    form.addEventListener("input", refresh);
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      await fetch("/api/signup", { method: "POST" });
      document.getElementById("toast").textContent = "Signed up";
    });
    document.getElementById("keyform").addEventListener("submit", async () => {
      await fetch("/api/keys", { method: "POST" });
    });
  </script>
</body></html>`;

/**
 * #161 — a regression of #75: a visually-hidden "Skip to content" anchor (the sr-only clipping
 * idiom) alongside two ordinary, always-actionable buttons.
 */
const SKIP_LINK_PAGE = (): string => `<!doctype html><html><body>
  <a href="#main" style="position:absolute;left:-10000px;top:auto;width:1px;height:1px;overflow:hidden">Skip to content</a>
  <main id="main">
    <button type="button" id="one" onclick="this.textContent='clicked one'">Action One</button>
    <button type="button" id="two" onclick="this.textContent='clicked two'">Action Two</button>
  </main>
</body></html>`;

/** A submit that never becomes enabled — the "never click a disabled control" guard's target. */
const STUCK_SUBMIT = `<!doctype html><html><body>
  <form id="f">
    <label>Name <input aria-label="Name" /></label>
    <button id="save" disabled>Save</button>
  </form>
</body></html>`;

const PROFILE = (): string => `<!doctype html><html><body>
  <h1>Profile</h1>
  <a href="#" id="ws" onclick="location.href='/'; return false;">Change workspace</a>
  <form id="profile" onsubmit="return false;">
    <label>First name <input name="first" aria-label="First name" value="Ada" /></label>
    <label>Last name <input name="last" aria-label="Last name" value="${state.lastName}" /></label>
    <label>Email <input name="email" type="email" aria-label="Email" value="ada@example.test" /></label>
    <label>Role <select name="role" aria-label="Role"><option>Admin</option><option>Member</option></select></label>
    <button type="button" id="cancel">Cancel</button>
    <button type="submit" id="save">Save</button>
  </form>
  <div id="toast" role="status"></div>
  <script>
    document.getElementById("profile").addEventListener("submit", async () => {
      const body = JSON.stringify({ last: document.querySelector("[name=last]").value });
      await fetch("/api/profile", { method: "PUT", body, headers: { "content-type": "application/json" } });
      document.getElementById("toast").textContent = "Saved";
    });
  </script>
</body></html>`;

const HOME = `<!doctype html><html><body><h1>Workspaces</h1>
  <button type="button">Acme</button><button type="button">Globex</button></body></html>`;

let server: Server;
let origin: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0] ?? "";
    if (path === "/api/profile" && req.method === "PUT") {
      state.puts += 1;
      // Slow enough that a second action lands while the save is still in flight.
      setTimeout(() => res.writeHead(200, { "content-type": "application/json" }).end("{}"), 300);
      return;
    }
    if (path === "/app/profile") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(PROFILE());
      return;
    }
    if (path === "/app/old") {
      res.writeHead(302, { location: "/" }).end();
      return;
    }
    if (path === "/api/keys" && req.method === "POST") {
      state.keySubmits += 1;
      res.writeHead(200, { "content-type": "application/json" }).end("{}");
      return;
    }
    if (path === "/api/signup" && req.method === "POST") {
      state.signups += 1;
      res.writeHead(200, { "content-type": "application/json" }).end("{}");
      return;
    }
    if (path === "/app/keys-and-signup") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(KEYS_AND_SIGNUP());
      return;
    }
    if (path === "/app/native-validation") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(NATIVE_VALIDATION_FORM());
      return;
    }
    if (path === "/api/signin-native" && req.method === "POST") {
      state.nativeSignins += 1;
      res.writeHead(200, { "content-type": "application/json" }).end("{}");
      return;
    }
    if (path === "/app/skip-link") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(SKIP_LINK_PAGE());
      return;
    }
    if (path === "/app/stuck-submit") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(STUCK_SUBMIT);
      return;
    }
    if (path === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(HOME);
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

const port = new PlaywrightBrowserPort();
const opened: string[] = [];
async function freshSession(): Promise<VerifySession> {
  const session = await port.open({ headless: true, allowedOrigins: [origin], baseUrl: origin });
  opened.push("fresh");
  const actor = CastActor.named("fresh").whoCan(new BrowseTheWeb(session, [origin]));
  return { page: session.page, actor, close: () => session.close() };
}

async function huntProfile(
  strategies: readonly MisuseStrategy[],
  extra: Partial<AdversarialMissionParams> = {},
): Promise<AdversarialOutcome> {
  return withSession(
    "adv-forms-",
    async (session) => {
      const actor = CastActor.named("adversary").whoCan(new BrowseTheWeb(session, [origin]));
      return runAdversarialMission({
        page: session.page,
        actor,
        judgment: new FakeJudgmentGateway({ looksBroken: { kind: "noul", value: false, probability: 0.1 } }),
        generation: new FakeGenerationGateway(),
        seedUrl: `${origin}/app/profile`,
        allowlist: [origin],
        strategies,
        ...extra,
      });
    },
    origin,
  );
}

describe("adversarial — form-aware misuse (#64)", () => {
  it(
    "a form page gets submit-centred misuse, including Save clicks, a double submit and a pending-save race",
    async () => {
      state.puts = 0;
      const result = await huntProfile(
        ["double-submit", "boundary-submit", "edit-cancel-save", "navigate-away-unsaved", "act-while-pending"],
        { bounds: { maxDecisions: 5 } },
      );

      expect(result.outcome).not.toBe("crashed");
      const steps = result.transcript;
      const byStrategy = (s: string) => steps.filter((e) => e.strategy === s);

      // Every form strategy found something to do on an ordinary form.
      for (const s of ["double-submit", "boundary-submit", "edit-cancel-save", "navigate-away-unsaved", "act-while-pending"]) {
        expect(byStrategy(s).length, s).toBeGreaterThan(0);
        expect(byStrategy(s).some((e) => e.reason?.includes("strategy found no applicable action")), s).toBe(false);
      }

      const saves = steps.filter((e) => e.op === "click" && e.target?.includes('"Save"') === true && e.actOk);
      expect(saves.length).toBeGreaterThanOrEqual(3);

      // double-submit: two Save clicks, the second before the first settled.
      expect(byStrategy("double-submit").map((e) => e.op)).toEqual(["type", "click", "click"]);
      expect(byStrategy("double-submit")[2]?.reason).toContain("submit again before the first submit settled");

      // edit → cancel → save.
      expect(byStrategy("edit-cancel-save").map((e) => e.target)).toEqual([
        expect.stringMatching(/textbox|combobox/),
        expect.stringContaining("Cancel"),
        expect.stringContaining("Save"),
      ]);

      // leave with an unsaved edit.
      const away = byStrategy("navigate-away-unsaved");
      expect(["type", "select"]).toContain(away[0]?.op);
      expect(away[1]?.op).toBe("reload");
      expect(away[1]?.actOk).toBe(true);

      // act while the save is in flight: the submit left a request pending, then the next action fired.
      const pending = byStrategy("act-while-pending");
      expect(pending.map((e) => e.op)).toEqual(["type", "click", "click"]);
      expect(pending[1]?.reason).toMatch(/request\(s\) in flight/);

      // The server really received the saves (the misuse is real, not simulated).
      expect(state.puts).toBeGreaterThanOrEqual(3);

      // Every executed action is in the Recording (the repro path): fills and clicks by descriptor.
      const kinds = result.recording.pages.flatMap((p) => p.steps.map((s) => s.step.kind));
      expect(kinds.filter((k) => k === "click").length).toBeGreaterThanOrEqual(saves.length);
      expect(kinds).toContain("fill");
    },
    180_000,
  );
});

describe("adversarial — scope containment (#64)", () => {
  it(
    "an action that leaves the target is recorded, the run resets to the start URL in a fresh page, and keeps exploring the target",
    async () => {
      opened.length = 0;
      const result = await huntProfile(["exercise-controls"], {
        bounds: { maxDecisions: 6 },
        openFreshSession: freshSession,
      });
      expect(result.outcome).not.toBe("crashed");

      // "Change workspace" (an in-page link whose script navigates to /) left the scope once.
      expect(result.scope.routeGlobs).toEqual(["/app/profile", "/app/profile/", "/app/profile/**"]);
      expect(result.scope.outOfScopeSteps).toBe(1);
      expect(result.scope.departures).toEqual([
        { step: expect.any(Number), url: `${origin}/`, action: "Change workspace" },
      ]);
      // Reset in a FRESH page (a new context), not by navigating the page it left.
      expect(result.scope.resets).toBe(1);
      expect(opened).toHaveLength(1);

      const t = result.transcript;
      const reset = t.findIndex((e) => e.strategy === "scope-reset");
      expect(reset).toBeGreaterThan(0);
      expect(t[reset]?.reason).toContain("reset to the start URL in a fresh page");
      // After the reset the run is back on the target and goes on exercising ITS controls; the
      // departing control is not clicked again.
      const after = t.slice(reset + 1);
      expect(after.length).toBeGreaterThan(0);
      expect(after.every((e) => e.url.endsWith("/app/profile"))).toBe(true);
      expect(after.map((e) => e.target)).toEqual(
        expect.arrayContaining([expect.stringContaining("First name"), expect.stringContaining("Last name")]),
      );
      expect(after.some((e) => e.target?.includes("Change workspace") === true)).toBe(false);
      // No step ever ran on the page outside the scope.
      expect(t.filter((e) => e.strategy === "exercise-controls").every((e) => e.url.endsWith("/app/profile"))).toBe(true);
    },
    180_000,
  );

  it(
    "a start URL that redirects out of its own scope proves nothing: inconclusive, never clean",
    async () => {
      const result = await huntProfile(["exercise-controls"], { seedUrl: `${origin}/app/old`, bounds: { maxDecisions: 3 } });
      expect(result.outcome).toBe("inconclusive");
      expect(result.stop).toBe("scope-unreachable");
      expect(result.failure).toEqual({
        kind: "target-unreachable",
        message: `the start URL left the target scope (landed on ${origin}/)`,
      });
      expect(result.transcript).toHaveLength(1);
    },
    180_000,
  );

  it(
    "extra --route globs widen the scope (the departure target becomes part of it)",
    async () => {
      const result = await huntProfile(["exercise-controls"], { bounds: { maxDecisions: 2 }, routeGlobs: ["/"] });
      expect(result.scope.routeGlobs).toContain("/");
      expect(result.scope.outOfScopeSteps).toBe(0);
    },
    180_000,
  );
});

describe("adversarial — coverage and an honest outcome (#64)", () => {
  it(
    "a low-coverage run on the form is inconclusive with its coverage attached, never clean",
    async () => {
      const result = await huntProfile(["boundary-input"], { bounds: { maxDecisions: 2 } });
      expect(result.defects).toEqual([]);
      expect(result.outcome).toBe("inconclusive");
      expect(result.failure?.kind).toBe("insufficient-coverage");
      expect(result.coverage.sufficient).toBe(false);
      expect(result.coverage.controls.exercised).toBe(1);
      expect(result.coverage.controls.total).toBeGreaterThanOrEqual(6);
      expect(result.coverage.forms).toEqual({ found: 1, submitted: 0, blocked: 0 });
      expect(result.coverage.shortfalls).toEqual(
        expect.arrayContaining([expect.stringMatching(/^1\/\d+ target controls exercised/), "no form was submitted (1 found)"]),
      );
    },
    180_000,
  );

  it(
    "a run with the default form strategies covers the target and reports clean, with its coverage",
    async () => {
      const result = await huntProfile(
        ["double-submit", "boundary-submit", "edit-cancel-save", "navigate-away-unsaved", "act-while-pending", "exercise-controls"],
        { bounds: { maxDecisions: 12 }, openFreshSession: freshSession },
      );
      expect(result.defects).toEqual([]);
      expect(result.outcome).toBe("clean");
      expect(result.coverage.sufficient).toBe(true);
      expect(result.coverage.forms.submitted).toBe(1);
      expect(result.coverage.controls.ratio).toBeGreaterThanOrEqual(0.25);
      expect(result.coverage.strategies["double-submit"]?.applied).toBeGreaterThan(0);
      expect(result.coverage.outOfScopeSteps).toBe(result.scope.outOfScopeSteps);
    },
    180_000,
  );

  it(
    "thresholds are configurable: a stricter ratio turns the same thin run inconclusive",
    async () => {
      const result = await huntProfile(["exercise-controls"], {
        bounds: { maxDecisions: 3 },
        routeGlobs: ["/"],
        coverageThresholds: { minControlRatio: 0.9, requireFormSubmit: false },
      });
      expect(result.outcome).toBe("inconclusive");
      expect(result.coverage.thresholds).toEqual({ minControlRatio: 0.9, requireFormSubmit: false });
      expect(result.coverage.shortfalls).toEqual([expect.stringMatching(/below the 90% threshold$/)]);
    },
    180_000,
  );
});

describe("adversarial — a form behind a modal trigger, and a password-gated form (#76)", () => {
  const FULL_FORM_STRATEGIES: readonly MisuseStrategy[] = [
    "double-submit",
    "boundary-submit",
    "edit-cancel-save",
    "navigate-away-unsaved",
    "act-while-pending",
    "exercise-controls",
  ];

  it(
    "the frontier opens the disclosure control's dialog AND fills the password field: both forms found and submitted",
    async () => {
      state.keySubmits = 0;
      state.signups = 0;
      const result = await huntProfile(FULL_FORM_STRATEGIES, {
        seedUrl: `${origin}/app/keys-and-signup`,
        bounds: { maxDecisions: 30, maxActions: 60 },
      });

      expect(result.outcome).not.toBe("crashed");
      expect(result.coverage.forms.found).toBe(2);
      expect(result.coverage.forms.submitted).toBeGreaterThanOrEqual(1);

      // Real submissions actually reached the server (a disabled button can never dispatch a real
      // submit, so this alone proves the password field really got filled and Sign up really enabled).
      expect(state.keySubmits).toBeGreaterThanOrEqual(1);
      expect(state.signups).toBeGreaterThanOrEqual(1);

      // The dialog's own trigger was clicked, and its field ("Name") was exercised once revealed.
      const opened = result.transcript.some((e) => e.target?.includes("Create new key") === true && e.actOk);
      expect(opened).toBe(true);

      // A password step is marked redacted, and its synthetic value never appears anywhere in the
      // Recording or the transcript in the clear.
      const pwSteps = result.transcript.filter((e) => e.redacted === true);
      expect(pwSteps.length).toBeGreaterThan(0);
      // No fill step in the Recording for the password field carries a plaintext value.
      const fills = result.recording.pages.flatMap((p) => p.steps.map((s) => s.step)).filter((s) => s.kind === "fill");
      const passwordFills = fills.filter((f) => JSON.stringify(f.target).includes("Password"));
      expect(passwordFills.length).toBeGreaterThan(0);
      for (const f of passwordFills) {
        expect(f.value).toMatchObject({ redacted: true });
        expect(f.value).not.toHaveProperty("value");
      }
    },
    180_000,
  );

  it(
    "never clicks a submit that stays disabled: a no-op is recorded instead of a failed click",
    async () => {
      const result = await huntProfile(["double-submit"], {
        seedUrl: `${origin}/app/stuck-submit`,
        bounds: { maxDecisions: 4 },
      });
      expect(result.outcome).not.toBe("crashed");
      const clicks = result.transcript.filter((e) => e.op === "click");
      expect(clicks).toEqual([]);
      const noOps = result.transcript.filter(
        (e) => e.strategy === "double-submit" && e.op === null && e.reason?.includes("disabled"),
      );
      expect(noOps.length).toBeGreaterThan(0);
    },
    180_000,
  );
});

describe("adversarial — a blocked submit is never counted as submitted (#155)", () => {
  it(
    "a submit the browser refuses with native validation (a still-empty required field) is recorded blocked, never submitted; the run is inconclusive, never clean",
    async () => {
      state.nativeSignins = 0;
      // Only ONE decision: double-submit edits a single field (Email — leaving Password required
      // and empty) and clicks Sign In twice. Both clicks are native-validation-blocked: no request
      // ever reaches the server.
      const result = await huntProfile(["double-submit"], {
        seedUrl: `${origin}/app/native-validation`,
        bounds: { maxDecisions: 1 },
      });

      expect(result.outcome).not.toBe("crashed");
      // The real ground truth: the server never saw a single request.
      expect(state.nativeSignins).toBe(0);

      expect(result.coverage.forms.found).toBe(1);
      expect(result.coverage.forms.submitted).toBe(0);
      expect(result.coverage.forms.blocked).toBeGreaterThanOrEqual(1);
      expect(result.coverage.shortfalls).toEqual(
        expect.arrayContaining([expect.stringMatching(/^form submitted 0 times \(\d+ attempts? blocked by validation/)]),
      );
      // Never silently `clean`: a run whose submits never reached the server proved nothing.
      expect(result.outcome).toBe("inconclusive");
      expect(result.failure?.kind).toBe("insufficient-coverage");

      // The submit clicks themselves were still real actions (the control was clicked); the
      // Recording's own click steps prove that — this is about the SUBMIT COUNT, not the click.
      const submitClicks = result.transcript.filter((e) => e.op === "click" && e.target?.includes('"Sign In"') === true && e.actOk);
      expect(submitClicks.length).toBeGreaterThanOrEqual(1);
    },
    180_000,
  );
});

describe("adversarial — a visually-hidden skip link is never chosen (#161, regression of #75)", () => {
  it(
    "exercise-controls / repeat-rapid / visit-route never target it, and it never appears as a not-actionable failure",
    async () => {
      const result = await huntProfile(["exercise-controls", "repeat-rapid", "visit-route"], {
        seedUrl: `${origin}/app/skip-link`,
        bounds: { maxDecisions: 10 },
      });

      expect(result.outcome).not.toBe("crashed");
      // Never a target, under any strategy, at any step.
      expect(result.transcript.some((e) => e.target?.includes("Skip to content") === true)).toBe(false);
      // The old failure mode (#161's repro) never happens at all: the control is excluded from the
      // start, so `act()`'s gate is never even asked about it.
      expect(result.transcript.some((e) => (e.reason ?? "").includes("visually-hidden skip link"))).toBe(false);
      // The run still did real work: the ordinary, fully-visible buttons WERE exercised.
      expect(result.transcript.some((e) => e.target?.includes("Action One") === true && e.actOk)).toBe(true);
      expect(result.transcript.some((e) => e.target?.includes("Action Two") === true && e.actOk)).toBe(true);
    },
    180_000,
  );
});
