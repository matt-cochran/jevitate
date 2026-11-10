import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeGenerationGateway, type GenInput, type GenTaskKind, type GenerationResult } from "@jevitate/ai-core";
import { RecordingInterpreter } from "@jevitate/interpreter";
import { BrowseTheWeb, CastActor } from "@jevitate/screenplay";
import type { Step } from "@jevitate/recording";
import { runGoalBasedMission } from "./missions/goal-based.js";
import { ScriptedJudge, withSession, useSkippingTime } from "./testkit.js";

// #304: Node and page time skip idle waits; assertions unchanged.
useSkippingTime({ per: "all" });

/**
 * #829: a goal-stated credential is never stored or shown to a model after it is typed. A sign-up
 * page (Email, Password, Create account), NO `--secret`: the goal states the password and the run
 * types it from the goal. It used to be stored in the clear — the Recording's fill
 * `{ redacted: false, value }` and its `intent` — and the goal carried it into every later model
 * call. Scripted judge + fake generator: no model call.
 */

/** The server accepts exactly this password: the MARKER no artifact or later payload may hold. */
const MARKER = "MARKER-pw-829x";
const EMAIL = "morgan@pinecrest.example";
const GOAL = `Create an account with email ${EMAIL} and password ${MARKER}.`;

const SIGNUP = `<!doctype html><html><body>
  <h1>Create your account</h1>
  <form method="post" action="/signup">
    <label for="email">Email</label> <input id="email" name="email" type="email" />
    <label for="pw">Password</label> <input id="pw" name="pw" type="password" />
    <button type="submit">Create account</button>
  </form>
</body></html>`;
const WELCOME = `<!doctype html><html><body><h1 data-testid="welcome">Account created</h1></body></html>`;

const count = (text: string, needle: string): number => text.split(needle).length - 1;

/** A fake generator that keeps every payload it was sent, and whether the run had learned the credential then. */
class CapturingGateway extends FakeGenerationGateway {
  readonly calls: Array<{ kind: string; input: unknown; afterFill: boolean }> = [];
  learned = false;
  override async generate<K extends GenTaskKind>(kind: K, input: GenInput<K>): Promise<GenerationResult<K>> {
    this.calls.push({ kind, input, afterFill: this.learned });
    return super.generate(kind, input);
  }
}

let server: Server;
let origin: string;
const signups: Array<{ email: string | null; pw: string | null }> = [];

function formBody(req: IncomingMessage): Promise<URLSearchParams> {
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
    if (req.method === "POST" && path === "/signup") {
      void formBody(req).then((f) => {
        signups.push({ email: f.get("email"), pw: f.get("pw") });
        if (f.get("pw") === MARKER) res.writeHead(303, { location: "/welcome" }).end();
        else html(400, "<p>wrong password</p><a href='/'>Back</a>");
      });
      return;
    }
    if (path === "/welcome") return html(200, WELCOME);
    html(200, SIGNUP);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("#829 — a goal-stated credential is redacted at rest and from later model calls", () => {
  it(
    "the password fill is { redacted: true }, the intent masks it, the email still records, no artifact or later payload holds the MARKER, and replay fails E_REDACTED_FILL",
    async () => {
      // Sign-up page: [0] Email, [1] Password, [2] Create account.
      const judge = new ScriptedJudge([{ op: "type", target: "0" }, { op: "type", target: "1" }, { op: "click", target: "2" }, { op: "done" }]);
      const gen = new CapturingGateway();
      const learned: string[] = [];
      let judgeCallsAtFill = -1;
      const result = await withSession(
        "goal-credential-",
        async (session) =>
          runGoalBasedMission({
            actor: CastActor.named("sign-up").whoCan(new BrowseTheWeb(session, [origin])),
            judge,
            gen,
            goal: GOAL,
            allowlist: [origin],
            startUrl: `${origin}/`,
            bounds: { maxDecisions: 8 },
            successChecks: [{ kind: "page", assertion: { kind: "visible", target: { testId: "welcome" } } }],
            oracleTimeoutMs: 1_000,
            onRunSecret: (v) => {
              learned.push(v);
              gen.learned = true;
              judgeCallsAtFill = judge.calls.length;
            },
          }),
        origin,
      );
      // The run still works: the real value reached the server.
      expect(result.outcome).toBe("succeeded");
      expect(signups).toEqual([{ email: EMAIL, pw: MARKER }]);
      // The caller learned the value as a run secret (the CLI masks its own artifacts with it).
      expect(learned).toEqual([MARKER]);

      // The Recording: the password fill redacted, the email fill (not a credential) in the clear.
      const steps: Step[] = result.recording.pages.flatMap((p) => p.steps.map((s) => s.step));
      const fills = steps.filter((s): s is Extract<Step, { kind: "fill" }> => s.kind === "fill");
      expect(fills).toHaveLength(2);
      expect(fills[0]!.value).toEqual({ redacted: false, value: EMAIL });
      expect(fills[1]!.value).toEqual({ redacted: true, length: MARKER.length });
      expect(result.recording.intent).toBe(`Create an account with email ${EMAIL} and password «redacted».`);

      // Every artifact the mission returns (Recording, transcript, run, reason, checks): zero.
      expect(count(JSON.stringify(result), MARKER)).toBe(0);
      expect(JSON.stringify(result.transcript)).toContain("«redacted»");

      // Every model payload AFTER the fill: the decision states, the goal checks, the generator.
      expect(judgeCallsAtFill).toBeGreaterThan(0);
      const laterJudge = judge.calls.slice(judgeCallsAtFill);
      expect(laterJudge.length).toBeGreaterThan(0);
      expect(count(JSON.stringify(laterJudge), MARKER)).toBe(0);
      expect(count(JSON.stringify(judge.goalCalls), MARKER)).toBe(0);
      expect(count(JSON.stringify(gen.calls.filter((c) => c.afterFill)), MARKER)).toBe(0);
      // The goal itself reaches later calls redacted, not dropped.
      expect(JSON.stringify(laterJudge)).toContain("password «redacted»");

      // Replay fails closed on the redacted fill, naming the field — the mask is never typed.
      const replay = await withSession(
        "goal-credential-replay-",
        async (fresh) => new RecordingInterpreter().run(CastActor.named("replay").whoCan(new BrowseTheWeb(fresh, [origin])), result.recording),
        origin,
      );
      expect(replay.outcome).toBe("failed");
      const error = replay.outcome === "failed" ? replay.error : "";
      expect(error).toContain("E_REDACTED_FILL");
      expect(error).toContain('"Password"');
      expect(signups).toHaveLength(1);
    },
    180_000,
  );
});
