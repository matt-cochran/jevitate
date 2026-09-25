import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeGenerationGateway } from "@jevitate/ai-core";
import { BrowseTheWeb, CastActor } from "@jevitate/screenplay";
import { explore, type ExploreRun } from "./explore.js";
import { GOAL_IS_SIGN_IN_QUESTION, GOAL_MET_QUESTION } from "./decide.js";
import { parseSecretField } from "./secret-fields.js";
import { ScriptedJudge, withSession, type ScriptedStep } from "./testkit.js";

/**
 * #188 item 4 — usability done-recognition. A review with the goal "Sign in … and complete two-factor
 * authentication" typed the password and the code, clicked Verify and landed on the signed-in home
 * page (`/`, an account button, a credit chip) — yet the model reported `blocked` and the run ended
 * incomplete. A usability run has no success check: "done" rests on grounding, and a model `blocked`
 * was accepted without asking whether the goal was already met, while the goal judgment saw only a
 * home page whose text never says "signed in".
 */

/** A SPA sign-in: /login (email + password) → 2FA on the same URL → pushState to the signed-in home `/`. */
const APP_HTML = `<!doctype html><html><body><div id="app"></div>
<script>
  const app = document.getElementById("app");
  function login() {
    app.innerHTML = '<h1>Sign in</h1><form id="f"><label>Email <input id="email" type="email" /></label>' +
      '<label>Password <input id="pw" type="password" /></label><button type="submit">Sign In</button></form>';
    document.getElementById("f").addEventListener("submit", (e) => { e.preventDefault(); twoFactor(); });
  }
  function twoFactor() {
    app.innerHTML = '<h1>Two-Factor Authentication</h1><p>Enter the code from your authenticator app</p>' +
      '<form id="f"><input id="code" aria-label="Six-digit authentication code" inputmode="numeric" />' +
      '<label><input type="checkbox" /> Remember this device for 30 days</label><button type="submit">Verify</button></form><p id="err" role="alert"></p>';
    document.getElementById("f").addEventListener("submit", (e) => {
      e.preventDefault();
      if (!/^\\d{6}$/.test(document.getElementById("code").value)) { document.getElementById("err").textContent = "Enter the 6-digit code"; return; }
      history.pushState({}, "", "/");
      home();
    });
  }
  function home() {
    app.innerHTML = '<nav><a href="/activity">Activity</a> <a href="/projects">Projects</a> <a href="/billing">1,808 credits</a>' +
      ' <button type="button">Account: Test User</button></nav><main><h1>Start something new</h1>' +
      '<button type="button">Start a new piece</button> <button type="button">Browse strategies</button></main>';
  }
  login();
</script></body></html>`;

let server: Server;
let base: string;
beforeAll(async () => {
  server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(APP_HTML);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

const env = { APP_PASSWORD: "correct-horse-battery-staple", APP_TOTP_SEED: "JBSWY3DPEHPK3PXP" };
const secretFields = [
  parseSecretField("type=password=env:APP_PASSWORD", "value", env),
  parseSecretField("label=Six-digit authentication code=env:APP_TOTP_SEED", "totp", env),
];

const SIGN_IN_GOAL = "Sign in as ada@example.test with the bound password and complete two-factor authentication.";

async function run(judge: ScriptedJudge, goal = SIGN_IN_GOAL): Promise<ExploreRun> {
  return withSession(
    "explore-sign-in-done-",
    async (session) => {
      const actor = CastActor.named("sign-in-done").whoCan(new BrowseTheWeb(session, [base]));
      return explore({
        actor,
        judge,
        gen: new FakeGenerationGateway(),
        goal,
        allowlist: [base],
        startUrl: `${base}/login`,
        secretFields,
        bounds: { maxDecisions: 10 },
      });
    },
    base,
  );
}

// Login: [0] Email, [1] Password, [2] Sign In. 2FA: [0] code, [1] Remember, [2] Verify.
const TO_TWO_FACTOR: ScriptedStep[] = [
  { op: "type", target: "0" },
  { op: "type", target: "1" },
  { op: "click", target: "2" },
  { op: "type", target: "0" },
];

/** A judge as timid as the live one: the home page's text alone never reads as "signed in". */
function judgeWith(steps: ScriptedStep[], goalIsSignIn: number): ScriptedJudge {
  const judge = new ScriptedJudge(steps);
  judge.goalMetProbability = 0.3;
  judge.noulProbabilities = { [GOAL_IS_SIGN_IN_QUESTION]: goalIsSignIn };
  return judge;
}

describe("sign-in done recognition (#188)", () => {
  it(
    "a model `blocked` on the signed-in home page ends the run done — code observed the sign-in complete",
    async () => {
      const judge = judgeWith([...TO_TWO_FACTOR, { op: "click", target: "2" }, { op: "blocked", confidence: 0.27 }], 0.95);
      const r = await run(judge);

      expect(r.stop).toBe("done");
      expect(r.outcome).toEqual({ status: "completed", verifiedBy: "sign-in-signals" });
      const last = r.transcript.at(-1);
      expect(last?.op).toBe("done");
      expect(last?.strategy).toBe("goal-check");
      expect(last?.reason).toMatch(/goal already met — stopped instead of "blocked": verified by sign-in-signals/);
      expect(last?.judgments?.goalIsSignIn).toEqual({ value: true, probability: 0.95 });
      expect(r.transcript.some((e) => e.reason === "model blocked")).toBe(false);

      // The goal judgment was given what code observed, and asked the scope question in the same call.
      const call = judge.goalCalls.at(-1);
      expect(Object.keys(call?.questions ?? {})).toEqual([GOAL_MET_QUESTION, GOAL_IS_SIGN_IN_QUESTION]);
      const facts = call?.state.controls.find((c) => c.startsWith("SIGN-IN (observed by code"));
      expect(facts).toMatch(/non-sign-in page/);
      expect(facts).toMatch(/signed-in control is shown \("Account: Test User"\)/);
      // No secret reached the judgment.
      expect(JSON.stringify(judge.goalCalls)).not.toContain(env.APP_PASSWORD);
    },
    90_000,
  );

  it(
    "a model `blocked` that is still on the 2FA form is never done — the run ends incomplete",
    async () => {
      const judge = judgeWith([...TO_TWO_FACTOR, { op: "blocked" }], 0.95);
      const r = await run(judge);

      expect(r.stop).toBe("blocked");
      expect(r.outcome.status).toBe("incomplete");
      expect(r.transcript.some((e) => e.op === "done" && e.actOk)).toBe(false);
      // It was asked — and code saw the sign-in unfinished.
      const facts = judge.goalCalls.at(-1)?.state.controls.find((c) => c.startsWith("SIGN-IN (observed by code"));
      expect(facts).toMatch(/still a sign-in page/);
      expect(facts).toMatch(/credential field is still shown/);
    },
    90_000,
  );

  it(
    "signed in, but the goal asks for more than signing in: `blocked` stands unless the goal judgment itself clears",
    async () => {
      const judge = judgeWith([...TO_TWO_FACTOR, { op: "click", target: "2" }, { op: "blocked" }], 0.1);
      const r = await run(judge, `${SIGN_IN_GOAL} Then create a project named Q3 launch.`);

      expect(r.stop).toBe("blocked");
      expect(r.outcome.status).toBe("incomplete");
    },
    90_000,
  );
});
