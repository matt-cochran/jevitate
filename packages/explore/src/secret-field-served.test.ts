import { createServer, type Server } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeGenerationGateway, type GenerationPort } from "@jevitate/ai-core";
import { BrowseTheWeb, CastActor } from "@jevitate/screenplay";
import { runGoalBasedMission } from "./missions/goal-based.js";
import { parseSecretField } from "./secret-fields.js";
import { totp } from "./totp.js";
import { ScriptedJudge, withSession } from "./testkit.js";

/**
 * #72 end to end (REAL Chromium): a login page (username + password) and an MFA page (a plain
 * text "Authentication code" input, so its value IS readable by the snapshot) behind a server stub
 * that checks the password and the TOTP code. The password and the TOTP seed are bound with
 * `--secret-field` / `--totp` semantics: code types them, the mission succeeds, and no plaintext —
 * password, seed or the typed code — reaches the model, the Recording or the transcript.
 */

const PASSWORD = `pw-canary-${randomUUID()}`;
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const SEED = [...randomBytes(32)].map((b) => B32[b % 32]).join("");
const accepted: string[] = [];

const LOGIN = `<!doctype html><html><body>
  <h1>Log in</h1>
  <form method="post" action="/login">
    <label for="user">Username</label> <input id="user" name="user" />
    <label for="pw">Password</label> <input id="pw" name="pw" type="password" />
    <button type="submit">Continue</button>
  </form>
</body></html>`;
const MFA = `<!doctype html><html><body>
  <h1>Two-factor authentication</h1>
  <form method="post" action="/mfa">
    <label for="code">Authentication code</label> <input id="code" name="code" inputmode="numeric" autocomplete="off" />
    <button type="submit">Verify</button>
  </form>
</body></html>`;
const HOME = `<!doctype html><html><body><h1 data-testid="welcome">Welcome, ada</h1><a href="/">Sign out</a></body></html>`;

let server: Server;
let origin: string;

function formBody(req: import("node:http").IncomingMessage): Promise<URLSearchParams> {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString()));
    req.on("end", () => resolve(new URLSearchParams(body)));
  });
}

beforeAll(async () => {
  server = createServer((req, res) => {
    const html = (status: number, page: string): void => void res.writeHead(status, { "content-type": "text/html; charset=utf-8" }).end(page);
    const path = (req.url ?? "/").split("?")[0];
    if (req.method === "POST" && path === "/login") {
      void formBody(req).then((f) => {
        if (f.get("pw") === PASSWORD) res.writeHead(303, { location: "/mfa" }).end();
        else html(401, "<p>wrong password</p><a href='/'>Back</a>");
      });
      return;
    }
    if (req.method === "POST" && path === "/mfa") {
      void formBody(req).then((f) => {
        const code = f.get("code") ?? "";
        const now = Date.now();
        // The usual ±1 step of clock drift.
        if ([now - 30_000, now, now + 30_000].some((t) => totp(SEED, t) === code)) {
          accepted.push(code);
          res.writeHead(303, { location: "/home" }).end();
        } else html(401, "<p>wrong code</p><a href='/mfa'>Back</a>");
      });
      return;
    }
    if (path === "/mfa") return html(200, MFA);
    if (path === "/home") return html(200, HOME);
    html(200, LOGIN);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("secret field binding — code types it, nothing else ever sees it (#72)", () => {
  it(
    "a password + TOTP login succeeds with no plaintext secret in any model payload, the Recording or the transcript",
    async () => {
      const env = { APP_PASSWORD: PASSWORD, APP_TOTP_SEED: SEED };
      const secretFields = [
        parseSecretField("type=password=env:APP_PASSWORD", "value", env),
        parseSecretField("label=Authentication code=env:APP_TOTP_SEED", "totp", env),
      ];
      const genInputs: string[] = [];
      const fake = new FakeGenerationGateway();
      const gen: GenerationPort = {
        generate: async (kind, input) => {
          genInputs.push(JSON.stringify(input));
          return fake.generate(kind, input);
        },
      };
      // Login: [0] Username, [1] Password, [2] Continue. MFA: [0] Authentication code, [1] Verify.
      const judge = new ScriptedJudge([
        { op: "type", target: "0" },
        { op: "type", target: "1" },
        { op: "click", target: "2" },
        { op: "type", target: "0" },
        { op: "click", target: "1" },
        { op: "done" },
      ]);
      const result = await withSession(
        "secret-field-",
        async (session) =>
          runGoalBasedMission({
            actor: CastActor.named("login").whoCan(new BrowseTheWeb(session, [origin])),
            judge,
            gen,
            // The goal even quotes the password: registered by the binding, it is redacted.
            goal: `Log in as ada with the password ${PASSWORD}, then finish two-factor authentication`,
            allowlist: [origin],
            startUrl: `${origin}/`,
            secretFields,
            successChecks: [{ kind: "page", assertion: { kind: "visible", target: { testId: "welcome" } } }],
            oracleTimeoutMs: 1_000,
          }),
        origin,
      );

      expect(result.outcome).toBe("succeeded");
      expect(accepted).toHaveLength(1);

      // The Recording: the username is a plain value; the password and the code are redacted fills.
      const fills = result.recording.pages.flatMap((p) => p.steps.map((s) => s.step)).filter((s) => s.kind === "fill");
      expect(fills.map((s) => (s.kind === "fill" ? s.value : null))).toEqual([
        { redacted: false, value: "value:Username" },
        { redacted: true, length: PASSWORD.length },
        { redacted: true, length: 6 },
      ]);

      // The model saw placeholders — in the mission context and on the bound controls.
      const shown = JSON.stringify(judge.calls);
      expect(shown).toContain("«secret:APP_PASSWORD»");
      expect(shown).toContain("«totp:APP_TOTP_SEED»");
      const typed = result.transcript.filter((e) => e.op === "type" && e.reason?.includes("bound secret"));
      expect(typed.map((e) => e.reason)).toEqual([
        "typed «secret:APP_PASSWORD» (bound secret, typed by code)",
        "typed «totp:APP_TOTP_SEED» (bound secret, typed by code)",
      ]);

      const code = accepted[0]!;
      const recording = JSON.stringify(result.recording);
      const transcript = JSON.stringify(result.transcript);
      for (const bytes of [shown, ...genInputs, recording, transcript, result.finalUrl]) {
        expect(bytes).not.toContain(PASSWORD);
        expect(bytes).not.toContain(encodeURIComponent(PASSWORD));
        expect(bytes).not.toContain(SEED);
      }
      // The typed code (6 digits) is checked where text is shown, not in timing numbers.
      const shownText = JSON.stringify(result.transcript.map((e) => [e.target, e.reason, e.url]));
      for (const bytes of [shown, ...genInputs, shownText]) expect(bytes).not.toContain(code);
    },
    120_000,
  );
});
