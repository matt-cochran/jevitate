import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeGenerationGateway, type GenerationPort } from "@jevitate/ai-core";
import { BrowseTheWeb, CastActor } from "@jevitate/screenplay";
import { runGoalBasedMission } from "./missions/goal-based.js";
import { ScriptedJudge, withSession } from "./testkit.js";

/**
 * #71 regression fixture — the issue's static signup form, served for real. The generator answers
 * every `form.value` with what dogfooding saw (a JSON map of every field): the values the goal
 * states verbatim are typed without it, and whatever it does answer is rejected, never typed.
 */

const PAGE = `<!doctype html><html><head><title>Form repro</title></head><body>
<h1>Create account</h1>
<form id="f" onsubmit="event.preventDefault(); f.hidden=true; ok.hidden=false; echo.textContent=email.value;">
  <label for="name">Name</label> <input id="name" name="name" required><br>
  <label for="email">Email</label> <input id="email" name="email" type="email" required><br>
  <label for="url">Website URL</label> <input id="url" name="url" type="url" required><br>
  <label for="nick">Nickname</label> <input id="nick" name="nick"><br>
  <button type="submit">Create Account</button>
</form>
<div id="ok" hidden data-testid="welcome">Welcome! Signed up as <span id="echo" data-testid="echo"></span></div>
</body></html>`;

const JSON_BLOB = '{"Name":"Ada Lovelace","Email":"ada@example.com","Website URL":"https://example.com"}';

let server: Server;
let origin: string;

beforeAll(async () => {
  server = createServer((_req, res) => res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(PAGE));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("goal mission — typed values are one field's value (#71)", () => {
  it(
    "the issue's repro passes: goal-stated values are typed verbatim, a JSON blob is rejected with its reason in history",
    async () => {
      const asked: string[] = [];
      const fake = new FakeGenerationGateway({ "form.value": { text: JSON_BLOB } });
      const gen: GenerationPort = {
        generate: async (kind, input) => {
          asked.push((input as { fieldLabel: string }).fieldLabel);
          return fake.generate(kind, input);
        },
      };
      // Controls: [0] Name, [1] Email, [2] Website URL, [3] Nickname, [4] Create Account.
      const judge = new ScriptedJudge([
        { op: "type", target: "0" },
        { op: "type", target: "1" },
        { op: "type", target: "2" },
        { op: "type", target: "3" },
        { op: "click", target: "4" },
        { op: "done" },
      ]);
      const result = await withSession(
        "form-value-",
        async (session) =>
          runGoalBasedMission({
            actor: CastActor.named("signup").whoCan(new BrowseTheWeb(session, [origin])),
            judge,
            gen,
            goal: "Sign up with name Ada Lovelace, email ada@example.com and website URL https://example.com, then submit.",
            allowlist: [origin],
            startUrl: `${origin}/`,
            successChecks: [
              { kind: "page", assertion: { kind: "textIncludes", target: { testId: "echo" }, text: "ada@example.com" } },
            ],
            oracleTimeoutMs: 500,
          }),
        origin,
      );

      expect(result.outcome).toBe("succeeded");
      const fills = result.recording.pages.flatMap((p) => p.steps.map((s) => s.step)).filter((s) => s.kind === "fill");
      expect(fills.map((s) => (s.kind === "fill" ? s.value : null))).toEqual([
        { redacted: false, value: "Ada Lovelace" },
        { redacted: false, value: "ada@example.com" },
        { redacted: false, value: "https://example.com" },
      ]);
      // Only the field the goal gives no value for went to the model — and its JSON blob was refused.
      expect(asked).toEqual(["Nickname"]);
      const rejected = result.transcript.find((e) => e.reason?.startsWith("typed value rejected"));
      expect(rejected?.actOk).toBe(false);
      expect(rejected?.reason).toContain("JSON object");
      const later = judge.states.at(-1)!;
      expect(later.history.some((h) => h.includes("typed value rejected"))).toBe(true);
    },
    120_000,
  );
});
