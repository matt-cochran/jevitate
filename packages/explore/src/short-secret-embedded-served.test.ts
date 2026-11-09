import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeGenerationGateway, FakeJudgmentGateway, type GenerationPort, type JudgmentPort } from "@jevitate/ai-core";
import { BrowseTheWeb, CastActor } from "@jevitate/screenplay";
import { explore } from "./explore.js";
import { runAdversarialMission } from "./missions/adversarial.js";
import { ScriptedJudge, withSession, useSkippingTime } from "./testkit.js";

// #304: Node and page time skip idle waits; assertions unchanged.
useSkippingTime({ per: "all" });

/**
 * F5 (0.29.0 accepted limit): a short secret (under 6 characters) was masked only as a whole token,
 * so `abcPw12xdef` reached the model on goal, adversarial and usability (which perceives through the
 * same `redactText`). Served page, real Chromium, spied gateways: no payload holds the secret, embedded
 * or alone, while an unrelated word holding a single-kind short secret's letters is left alone.
 */
const SECRET = "Pw12x";
const PIN = "1234";
const PAGE = `<!doctype html><html><head><title>Account</title></head><body>
<h1>Account abcPw12xdef</h1>
<p>Reference code abcPw12xdef and pin1234x, order 12345.</p>
<button aria-label="Copy abcPw12xdef">Copy</button>
<label>Reference <input aria-label="Reference" value="zzPw12xzz"></label>
<button type="button">Save</button>
</body></html>`;

let server: Server;
let origin: string;
beforeAll(async () => {
  server = createServer((_req, res) => res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(PAGE));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

const spyGen = (inner: GenerationPort): { gen: GenerationPort; inputs: unknown[] } => {
  const inputs: unknown[] = [];
  return { inputs, gen: { generate: async (kind, input) => (inputs.push({ kind, input }), inner.generate(kind, input)) } };
};
const spyJudge = (inner: JudgmentPort): { judge: JudgmentPort; payloads: unknown[] } => {
  const payloads: unknown[] = [];
  return { payloads, judge: { systemOne: async (args) => (payloads.push(args), inner.systemOne(args)) } };
};
const sent = (x: unknown): string => JSON.stringify(x);

describe("F5 — a short secret inside a longer token never reaches a model", () => {
  it(
    "goal: the secret embedded in text, a label and a field value is masked; 12345 is untouched",
    async () => {
      const j = spyJudge(new ScriptedJudge([{ op: "done" }]));
      const g = spyGen(new FakeGenerationGateway());
      const run = await withSession(
        "short-secret-goal-",
        async (session) =>
          explore({
            actor: CastActor.named("goal").whoCan(new BrowseTheWeb(session, [origin])),
            judge: j.judge,
            gen: g.gen,
            goal: "Read the account page.",
            allowlist: [origin],
            startUrl: `${origin}/`,
            secrets: [SECRET, PIN],
            readOnly: true,
            bounds: { maxDecisions: 2 },
          }),
        origin,
      );
      const all = sent([j.payloads, g.inputs, run.transcript, run.recording]);
      expect(j.payloads.length).toBeGreaterThan(0);
      expect(all).not.toContain(SECRET);
      expect(all).not.toContain("pin1234x");
      expect(sent(j.payloads)).toContain("abc«redacted»def");
      expect(sent(j.payloads)).toContain("12345");
    },
    90_000,
  );

  it(
    "adversarial: no judgment or generation payload holds the embedded secret",
    async () => {
      const j = spyJudge(new FakeJudgmentGateway({ looksBroken: { kind: "noul", value: false, probability: 0.1 } }));
      const g = spyGen(new FakeGenerationGateway());
      const result = await withSession(
        "short-secret-adv-",
        async (session) =>
          runAdversarialMission({
            page: session.page,
            actor: CastActor.named("adversary").whoCan(new BrowseTheWeb(session, [origin])),
            judgment: j.judge,
            generation: g.gen,
            seedUrl: `${origin}/`,
            allowlist: [origin],
            secrets: [SECRET],
            strategies: ["boundary-input"],
            bounds: { maxDecisions: 4 },
          }),
        origin,
      );
      expect(j.payloads.length + g.inputs.length).toBeGreaterThan(0);
      expect(sent([j.payloads, g.inputs, result.transcript, result.recording])).not.toContain(SECRET);
    },
    120_000,
  );
});
