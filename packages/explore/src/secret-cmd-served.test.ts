import { createServer, type Server } from "node:http";
import { randomInt } from "node:crypto";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeGenerationGateway } from "@jevitate/ai-core";
import { BrowseTheWeb, CastActor } from "@jevitate/screenplay";
import { runGoalBasedMission } from "./missions/goal-based.js";
import { parseSecretField, type SecretCommandRunner } from "./secret-fields.js";
import { ScriptedJudge, withSession, useSkippingTime } from "./testkit.js";

// #304: Node and page time skip idle waits; assertions unchanged.
useSkippingTime({ per: "all" });

/**
 * #324 — a one-time code delivered DURING the run ("We emailed you a code"): it can't be read at
 * start. A `cmd:` binding reads it at type time (here a fake outbox the command reads); code types it,
 * it becomes a run secret the moment it is read, and no model payload, Recording or transcript holds it.
 */
let code = "";
const verified: string[] = [];
const PAGE = `<!doctype html><html><head><meta charset="utf-8"></head><body>
<h1>Verify your email</h1><p>We emailed you a 6-digit code.</p>
<form method="post" action="/verify"><label for="c">Verification code</label> <input id="c" name="c" autocomplete="off" />
<button type="submit">Verify</button></form></body></html>`;

let server: Server;
let origin: string;
beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.method === "POST" && req.url === "/verify") {
      let body = "";
      req.on("data", (c: Buffer) => (body += c.toString()));
      req.on("end", () => {
        const got = new URLSearchParams(body).get("c") ?? "";
        if (got === code) {
          verified.push(got);
          res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(`<h1 data-testid="ok">Email verified</h1><p>Your code ${got} was accepted.</p>`);
        } else res.writeHead(401, { "content-type": "text/html" }).end("<p>wrong code</p>");
      });
      return;
    }
    // Loading the page "sends the email": a fresh code lands in the outbox now, after the run started.
    code = String(randomInt(100_000, 1_000_000));
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(PAGE);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

describe("cmd: secret source (#324)", () => {
  it("types a code delivered mid-run; it never reaches the model, the Recording or the transcript", async () => {
    const commands: string[] = [];
    // The outbox reader (what --allow-secret-cmd runs in a shell): here, read the code just "sent".
    const run: SecretCommandRunner = async (command) => {
      commands.push(command);
      return `${code}\n`;
    };
    const secretFields = [parseSecretField("label=Verification code=cmd:./read-code.sh --to ada@example.test", "value", {}, { allowCmd: true })];
    // [0] Verification code, [1] Verify.
    const judge = new ScriptedJudge([{ op: "type", target: "0" }, { op: "click", target: "1" }, { op: "done" }]);
    const result = await withSession(
      "secret-cmd-",
      async (session) =>
        runGoalBasedMission({
          actor: CastActor.named("verifier").whoCan(new BrowseTheWeb(session, [origin])),
          judge,
          gen: new FakeGenerationGateway(),
          goal: "Verify your email with the code we sent",
          allowlist: [origin],
          startUrl: `${origin}/verify-email`,
          secretFields,
          secretCommand: run,
          successChecks: [{ kind: "page", assertion: { kind: "visible", target: { testId: "ok" } } }],
          oracleTimeoutMs: 1_000,
        }),
      origin,
    );

    expect(result.outcome).toBe("succeeded");
    expect(verified).toEqual([code]);
    expect(commands).toEqual(["./read-code.sh --to ada@example.test"]);
    const fills = result.recording.pages.flatMap((p) => p.steps.map((s) => s.step)).filter((s) => s.kind === "fill");
    expect(fills.map((s) => (s.kind === "fill" ? s.value : null))).toEqual([{ redacted: true, length: 6 }]);
    const shown = JSON.stringify(judge.calls);
    expect(shown).toContain("«secret:CMD_VERIFICATION_CODE»");
    // The success page even echoes the code: registered when read, it is scrubbed everywhere.
    for (const bytes of [shown, JSON.stringify(result.recording), JSON.stringify(result.transcript), result.finalUrl]) {
      expect(bytes).not.toContain(code);
    }
  }, 60_000);

  it("a command that prints nothing fails the type step (the model is told why), never types a guess", async () => {
    const secretFields = [parseSecretField("label=Verification code=cmd:./read-code.sh", "value", {}, { allowCmd: true })];
    const judge = new ScriptedJudge([{ op: "type", target: "0" }, { op: "done" }]);
    const result = await withSession(
      "secret-cmd-empty-",
      async (session) =>
        runGoalBasedMission({
          actor: CastActor.named("verifier").whoCan(new BrowseTheWeb(session, [origin])),
          judge,
          gen: new FakeGenerationGateway(),
          goal: "Verify your email with the code we sent",
          allowlist: [origin],
          startUrl: `${origin}/verify-email`,
          secretFields,
          secretCommand: async () => "  \n",
          successChecks: [{ kind: "page", assertion: { kind: "visible", target: { testId: "ok" } } }],
          oracleTimeoutMs: 500,
        }),
      origin,
    );
    expect(result.outcome).not.toBe("succeeded");
    const typed = result.transcript.find((e) => e.op === "type");
    expect(typed?.actOk).toBe(false);
    expect(typed?.reason).toMatch(/«secret:CMD_VERIFICATION_CODE»: its command printed nothing/);
    expect(result.recording.pages.flatMap((p) => p.steps).filter((s) => s.step.kind === "fill")).toEqual([]);
  }, 60_000);
});
