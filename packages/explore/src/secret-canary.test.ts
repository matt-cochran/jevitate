import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  FakeGenerationGateway,
  REDACTION_MASK,
  type Answer,
  type JudgmentPort,
  type JudgmentState,
} from "@jevitate/ai-core";
import { BrowseTheWeb, CastActor } from "@jevitate/screenplay";
import type { Step } from "@jevitate/recording";
import { explore } from "./index.js";
import { withSession } from "./testkit.js";

/**
 * Secret canary (end to end, REAL Chromium): per-run random canaries planted
 * everywhere a secret can hide on a trivial local page — a registered secret in
 * a page LABEL and in the mission GOAL, an unregistered one in a SENSITIVE
 * query/fragment param, and one as the value of a REVEALED password field
 * (`type=text autocomplete=current-password`, i.e. after a "show password"
 * toggle). A fake JudgmentPort captures every payload the model would see.
 * No canary (raw or URL-encoded) may appear in any payload or in the Recording.
 */

// A space and a slash make the URL-encoded form differ from the raw value.
const REGISTERED = `jev canary/${randomUUID()}`;
const URL_CANARY = `urlcanary-${randomUUID()}`;
const PASSWORD_CANARY = `pwcanary-${randomUUID()}`;

const PAGE = `<!doctype html><html><body>
  <h1>Account</h1>
  <label for="pw">Password</label>
  <input id="pw" type="text" autocomplete="current-password" value="${PASSWORD_CANARY}" />
  <button id="go" type="button">Open ${REGISTERED}</button>
  <script>
    document.getElementById("go").addEventListener("click", () => {
      location.href = "/next?session=${URL_CANARY}&page=2#access_token=${URL_CANARY}";
    });
  </script>
</body></html>`;

let server: Server;
let origin: string;

beforeAll(async () => {
  server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(PAGE);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (addr === null || typeof addr === "string") throw new Error("server has no TCP address");
  origin = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
});

/** Clicks the first button, then declares done; keeps every payload it was sent. */
class CapturingJudge implements JudgmentPort {
  readonly payloads: string[] = [];
  readonly states: JudgmentState[] = [];
  #calls = 0;
  async systemOne(args: {
    state: JudgmentState;
    questions: Record<string, { kind: string; options?: readonly string[] }>;
  }): Promise<Record<string, Answer>> {
    this.payloads.push(JSON.stringify(args));
    this.states.push(args.state);
    this.#calls += 1;
    if (this.#calls > 1) return { action: { kind: "choice", value: "done", confidence: 0.9 } };
    const line = args.state.controls.find((c) => /^\[\d+\] button/.test(c));
    if (line === undefined) throw new Error(`no button control in ${JSON.stringify(args.state.controls)}`);
    const index = /^\[(\d+)\]/.exec(line)?.[1];
    if (index === undefined) throw new Error(`unindexed control line ${line}`);
    return { action: { kind: "choice", value: `click:${index}`, confidence: 0.9 } };
  }
}

const forms = (v: string): readonly string[] => [v, encodeURIComponent(v)];
const CANARIES: readonly string[] = [...forms(REGISTERED), ...forms(URL_CANARY), ...forms(PASSWORD_CANARY)];

describe("secret canary — nothing reaches Jev or the Recording", () => {
  it(
    "a registered secret (label + goal), a sensitive query/fragment param and a revealed password field never leak",
    async () => {
      const judge = new CapturingJudge();
      const run = await withSession(
        "explore-secret-canary-",
        async (session) => {
          const actor = CastActor.named("canary").whoCan(new BrowseTheWeb(session, [origin]));
          return explore({
            actor,
            judge,
            gen: new FakeGenerationGateway(),
            goal: `open the account for ${REGISTERED}`,
            allowlist: [origin],
            startUrl: `${origin}/?token=${encodeURIComponent(URL_CANARY)}&view=summary`,
            secrets: [REGISTERED],
          });
        },
        origin,
      );

      // The loop really ran: a click was recorded and the page navigated.
      expect(judge.payloads.length).toBe(2);
      const steps: Step[] = run.recording.pages.flatMap((p) => p.steps.map((s) => s.step));
      expect(steps.map((s) => s.kind)).toContain("click");

      // The seams really fired (a vacuous pass would see no masks at all).
      expect(judge.states[0]!.goal).toContain(REDACTION_MASK);
      expect(judge.states[0]!.url).toContain(`token=${REDACTION_MASK}`);
      expect(judge.states[0]!.url).toContain("view=summary");
      expect(judge.states[1]!.url).toContain(`session=${REDACTION_MASK}`);
      expect(judge.states[1]!.url).toContain(`#access_token=${REDACTION_MASK}`);
      expect(run.recording.intent).toContain(REDACTION_MASK);
      expect(JSON.stringify(steps.find((s) => s.kind === "click"))).toContain(REDACTION_MASK);

      const recordingBytes = JSON.stringify(run.recording);
      const everything = [...judge.payloads, recordingBytes, JSON.stringify(run.transcript), run.finalUrl];
      for (const canary of CANARIES) {
        for (const bytes of everything) expect(bytes).not.toContain(canary);
      }
    },
    120_000,
  );
});
