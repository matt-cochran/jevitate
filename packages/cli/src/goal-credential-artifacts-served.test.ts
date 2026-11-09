import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync, readdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PlaywrightBrowserPort } from "@jevitate/playwright";
import { FakeGenerationGateway, type GenInput, type GenTaskKind, type GenerationResult } from "@jevitate/ai-core";
import { runExploration } from "./explore-goal.js";
import { ScriptedJudge, useSkippingTime } from "../../explore/src/testkit.js";

// #304: Node and page time skip idle waits; assertions unchanged.
// #547: screenshots need the browser's own requestAnimationFrame (the pixel mask), so the page keeps its clock.
useSkippingTime({ per: "all", pageClock: false });

/**
 * #829: a goal-stated credential is in NO written artifact. A change-password page through
 * `runExploration`, NO `--secret`: the goal states the new password and the run types it. Every
 * file the run writes (result, Recording, transcript, evidence, logs) and every generator payload is
 * grepped for the MARKER. Scripted judge + fake generator: no model call.
 */

const MARKER = "MARKER-pw-829y";
const EMAIL = "morgan@pinecrest.example";

const FORM = `<!doctype html><html><body>
  <h1>Change your password</h1>
  <form method="post" action="/change">
    <label for="email">Email</label> <input id="email" name="email" type="email" />
    <label for="pw">New password</label> <input id="pw" name="pw" type="password" autocomplete="new-password" />
    <button type="submit">Save password</button>
  </form>
</body></html>`;
const DONE = `<!doctype html><html><body><h1 data-testid="changed">Password changed</h1></body></html>`;

class CapturingGateway extends FakeGenerationGateway {
  readonly payloads: string[] = [];
  override async generate<K extends GenTaskKind>(kind: K, input: GenInput<K>): Promise<GenerationResult<K>> {
    this.payloads.push(JSON.stringify(input));
    return super.generate(kind, input);
  }
}

let server: Server;
let origin: string;
const changes: Array<string | null> = [];

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
    if (req.method === "POST" && path === "/change") {
      void formBody(req).then((f) => {
        changes.push(f.get("pw"));
        res.writeHead(303, { location: "/done" }).end();
      });
      return;
    }
    if (path === "/done") return html(200, DONE);
    html(200, FORM);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("#829 — a goal-stated password is in no written artifact", () => {
  it("result, Recording, transcript and every other file the run writes hold the MARKER 0 times; the email still records", async () => {
    const out = await mkdtemp(join(tmpdir(), "jev-goal-cred-"));
    try {
      // Form: [0] Email, [1] New password, [2] Save password.
      const judge = new ScriptedJudge([{ op: "type", target: "0" }, { op: "type", target: "1" }, { op: "click", target: "2" }, { op: "done" }]);
      const gen = new CapturingGateway();
      const result = await runExploration({
        url: `${origin}/`,
        allowlist: [origin],
        goal: `Change the password for email ${EMAIL} to new password ${MARKER}.`,
        successAssertion: { kind: "visible", target: { testId: "changed" } },
        judge,
        gen,
        outDir: out,
        bounds: { maxDecisions: 8 },
        screenshots: { mode: "steps" },
        browserPortFactory: () => new PlaywrightBrowserPort(),
      });
      const r = result as unknown as { goalOutcome: string; resultPath: string };
      expect(r.goalOutcome).toBe("succeeded");
      // The real value reached the server.
      expect(changes).toEqual([MARKER]);
      const files: string[] = [];
      const walk = (d: string): void => {
        for (const e of readdirSync(d, { withFileTypes: true })) {
          const f = join(d, e.name);
          if (e.isDirectory()) walk(f);
          else files.push(f);
        }
      };
      walk(out);
      const text = files.filter((f) => /\.(json|md|txt|jsonl|log)$/.test(f));
      expect(text).toContain(r.resultPath);
      expect(text.length).toBeGreaterThanOrEqual(3);
      let total = 0;
      for (const f of text) total += readFileSync(f, "utf8").split(MARKER).length - 1;
      expect(total).toBe(0);
      expect(JSON.stringify(result).split(MARKER).length - 1).toBe(0);
      // No over-redaction: the email field's value still records, in the result's Recording.
      expect(readFileSync(r.resultPath, "utf8")).toContain(`"value": "${EMAIL}"`);
      // The decision states after the password was typed (from the 3rd on) and every goal check.
      expect(JSON.stringify(judge.calls.slice(2)).split(MARKER).length - 1).toBe(0);
      expect(JSON.stringify(judge.goalCalls).split(MARKER).length - 1).toBe(0);
      expect(gen.payloads.filter((p) => p.includes(MARKER))).toEqual([]);
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  }, 180_000);
});
