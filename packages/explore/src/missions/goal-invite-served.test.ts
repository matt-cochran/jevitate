import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FakeGenerationGateway } from "@jevitate/ai-core";
import { BrowseTheWeb, CastActor } from "@jevitate/screenplay";
import { runGoalBasedMission, type GoalBasedResult } from "./goal-based.js";
import { ScriptedJudge, withSession, type ScriptedStep } from "../testkit.js";

/**
 * #235 — "Invite a teammate … Use the email jevitate-teammate@example.com", checked by
 * `reloadThen:textIncludes:css=body|<email>` under `--success-when held`. The run typed the email,
 * "Send invite" was refused as paid (the goal-asked exemption did not apply), the model gave up, and
 * code turned its `blocked` into "goal already met" — on an in-run check that evaluated NOTHING (the
 * only check is judged after the run) — so the run ended `failed` after the reload instead of
 * `blocked` on the refusal. Real Chromium, a served team page whose invite is a POST.
 */

const EMAIL = "jevitate-teammate@example.com";
let invited: string[] = [];

const team = (): string => `<!doctype html><html><body><main><h1>Team</h1>
<ul>${["owner@example.com", ...invited].map((m) => `<li>${m}</li>`).join("")}</ul>
<form id="f"><label>Invite by email <input type="email" name="email" aria-label="Invite by email"></label>
<button type="submit">Send invite</button></form><p role="status" id="s"></p></main>
<script>
document.getElementById("f").addEventListener("submit", async (e) => {
  e.preventDefault();
  const r = await fetch("/api/invites", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(Object.fromEntries(new FormData(e.target))) });
  document.getElementById("s").textContent = r.ok ? "Invite sent" : "Failed";
});
</script></body></html>`;

let server: Server;
let origin: string;
beforeAll(async () => {
  server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0] ?? "/";
    if (path === "/api/invites" && req.method === "POST") {
      let raw = "";
      req.on("data", (c: Buffer) => (raw += c.toString("utf8")));
      req.on("end", () => {
        invited.push((JSON.parse(raw) as { email: string }).email);
        res.writeHead(201, { "content-type": "application/json" }).end('{"ok":true}');
      });
      return;
    }
    if (path === "/team") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(team());
      return;
    }
    res.writeHead(404).end("not found");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
beforeEach(() => {
  invited = [];
});

async function run(goal: string, steps: ScriptedStep[]): Promise<GoalBasedResult> {
  return withSession(
    "goal-invite-",
    async (session) => {
      const actor = CastActor.named("inviter").whoCan(new BrowseTheWeb(session, [origin]));
      return runGoalBasedMission({
        actor,
        judge: new ScriptedJudge(steps),
        gen: new FakeGenerationGateway(),
        goal,
        allowlist: [origin],
        startUrl: `${origin}/team`,
        waitOpMs: 300,
        successChecks: [{ kind: "reloadThen", assertion: { kind: "textIncludes", target: { css: "body" }, text: EMAIL } }],
        successWhen: "held",
        bounds: { maxDecisions: 6 },
      });
    },
    origin,
  );
}

// /team: [0] Invite by email, [1] Send invite.
describe("#235 — a goal that asks to invite may send the invite; a vacuous in-run hold never ends the run", () => {
  it(
    "'Invite a teammate': 'Send invite' is the goal-asked exemption — clicked, the invite is sent, and the reload check holds",
    async () => {
      const r = await run(`Invite a teammate to your workspace. Use the email ${EMAIL}.`, [
        { op: "type", target: "0" },
        { op: "click", target: "1" },
        { op: "done" },
      ]);
      expect(r.transcript.some((e) => /refused by the safety policy/.test(e.reason ?? ""))).toBe(false);
      expect(invited).toEqual([EMAIL]);
      expect(r.outcome).toBe("succeeded");
    },
    90_000,
  );

  it(
    "a refused 'Send invite' then `blocked`: never 'goal already met' over a check judged only after the run — blocked, naming the refusal",
    async () => {
      const r = await run(`Add ${EMAIL} to your workspace team.`, [{ op: "type", target: "0" }, { op: "click", target: "1" }, { op: "blocked" }]);
      expect(invited).toEqual([]);
      expect(r.transcript.some((e) => /goal already met/.test(e.reason ?? ""))).toBe(false);
      expect(r.outcome).toBe("blocked");
      expect(r.reason).toMatch(/cannot be advanced from this page \(refused by the safety policy: "Send invite" may cost money or contact real people/);
    },
    90_000,
  );
});
