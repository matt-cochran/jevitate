import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeGenerationGateway, type Answer, type JudgmentPort } from "@jevitate/ai-core";
import { MissionResultSchema } from "@jevitate/domain";
import { CLI_ADVERSARIAL_STRATEGIES, runAdversarialCliMission, runCoverageMission, runFeatureCliMission } from "./explore-api.js";

/**
 * #209 — outcome truthfulness: a run that proved nothing is never clean, its reason is never hidden,
 * and every defect is in the result's top-level `defects`. Served pages, real Chromium, deterministic
 * fake judges (never flagging anything).
 *
 *  - item 3: a `--feature` run whose every exercised control is unrelated to the feature (all
 *    relevance=0) is `inconclusive`, like the chrome-only case — never `clean`.
 *  - item 4: an adversarial run whose every target control is refused by the safety policy (three
 *    "Buy" buttons, paid) stops early (`targets-refused`), and its failure names the refusal and
 *    how to permit it (`--allow-destructive`, `--paid`/`--deny`).
 *  - item 5: a small app whose pages link to each other in their BODY is covered (`clean`,
 *    `exhausted`); the same links inside `<nav>` are global navigation: `insufficient-coverage` —
 *    one name for outcome and failure.kind — with a hint on how to reach clean.
 *  - item 6: a coverage run's horizontal-overflow defect is in top-level `defects`, not only in
 *    `coverage.defects`.
 */

const PAGES: Record<string, string> = {
  // item 3 — a profile page whose controls have nothing to do with "edit profile".
  "/account": `<!doctype html><html><body><main><h1>Your account</h1>
    <p id="tip">Tip 1</p>
    <button type="button" onclick="document.getElementById('tip').textContent = 'Tip 2'">Next tip</button>
    <button type="button" onclick="document.getElementById('tip').hidden = !document.getElementById('tip').hidden">Hide tips</button>
    </main></body></html>`,
  // item 4 — every target control is a paid "Buy" button.
  "/shop": `<!doctype html><html><body><main><h1>Shop</h1>
    <ul><li>Starter pack <button type="button">Buy</button></li>
    <li>Pro pack <button type="button">Buy</button></li>
    <li>Team pack <button type="button">Buy</button></li></ul>
    </main></body></html>`,
  // item 5 — two pages that link to each other in their body content.
  "/story": `<!doctype html><html><body><main><h1>Part one</h1><p>It begins.</p>
    <a href="/story/two">Read part two</a></main></body></html>`,
  "/story/two": `<!doctype html><html><body><main><h1>Part two</h1><p>It ends.</p>
    <a href="/story">Back to part one</a></main></body></html>`,
  // item 5 — the same two pages, their only links in a <nav> landmark (global navigation).
  "/docs": `<!doctype html><html><body><nav><a href="/docs/two">Docs two</a></nav><main><h1>Docs one</h1><p>Text.</p></main></body></html>`,
  "/docs/two": `<!doctype html><html><body><nav><a href="/docs">Docs one</a></nav><main><h1>Docs two</h1><p>Text.</p></main></body></html>`,
  // item 6 — a page wider than the viewport.
  "/wide": `<!doctype html><html><body style="margin:0"><main><h1>Report</h1>
    <table data-testid="grid" style="width:3000px"><tr><td>wide</td></tr></table>
    <button type="button" onclick="this.textContent = 'Refreshed'">Refresh</button></main></body></html>`,
};

let server: Server;
let origin: string;
let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "jev-209-"));
  server = createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0] ?? "";
    const body = PAGES[path];
    if (body === undefined) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(dir, { recursive: true, force: true });
});

/** Never flags a state, never proposes anything but the first option. */
const quietJudge: JudgmentPort = {
  async systemOne({ questions }) {
    const out: Record<string, Answer> = {};
    for (const [key, q] of Object.entries(questions)) {
      if (q.kind === "noul") out[key] = { kind: "noul", value: false, probability: 0.1 };
      else if (q.kind === "score") out[key] = { kind: "score", value: 0.1 };
      else out[key] = { kind: "choice", value: q.options[0] ?? "", confidence: 0.9 };
    }
    return out;
  },
};

let n = 0;
const outDir = (): string => join(dir, `run-${n++}`);

describe("#209 item 3 — a feature run that exercised nothing relevant is never clean", () => {
  it(
    "every exercised control at relevance=0: inconclusive (insufficient-coverage), naming the feature's words",
    async () => {
      const r = await runFeatureCliMission({
        seedUrl: `${origin}/account`,
        allowlist: [origin],
        capability: "Edit profile",
        routeGlobs: ["/account"],
        bounds: { maxActions: 6 },
        outDir: outDir(),
      });
      expect(r.coverage.inScopeActionsExercised).toBeGreaterThan(0);
      expect(r.coverage.relevantActionsExercised).toBe(0);
      expect(r.missionOutcome).toBe("inconclusive");
      expect(r.exitCode).toBe(2);
      expect(r.failure?.kind).toBe("insufficient-coverage");
      expect(r.failure?.message).toContain('no control relevant to "Edit profile" was exercised');
      expect(r.failure?.message).toContain("relevance=0");
    },
    180_000,
  );

  it(
    "a feature whose controls WERE exercised (relevance > 0) stays clean",
    async () => {
      const r = await runFeatureCliMission({
        seedUrl: `${origin}/account`,
        allowlist: [origin],
        capability: "browse tips",
        routeGlobs: ["/account"],
        bounds: { maxActions: 6 },
        outDir: outDir(),
      });
      expect(r.coverage.relevantActionsExercised).toBeGreaterThan(0);
      expect(r.missionOutcome).toBe("clean");
    },
    180_000,
  );
});

describe("#209 item 4 — adversarial names a safety-policy refusal and stops early", () => {
  it(
    "every target refused as paid: stop targets-refused, inconclusive, the failure names it and the flags",
    async () => {
      const r = await runAdversarialCliMission({
        seedUrl: `${origin}/shop`,
        allowlist: [origin],
        strategies: CLI_ADVERSARIAL_STRATEGIES,
        judgment: quietJudge,
        generation: new FakeGenerationGateway({}),
        bounds: { maxActions: 120, maxDecisions: 120 },
        outDir: outDir(),
      });
      expect(r.stop).toBe("targets-refused");
      expect(r.missionOutcome).toBe("inconclusive");
      expect(r.failure?.kind).toBe("insufficient-coverage");
      expect(r.failure?.message).toContain("0/3 target controls exercised");
      expect(r.failure?.message).toContain('all 3 refused by the safety policy (paid: "Buy" x3)');
      expect(r.failure?.message).toContain("--allow-destructive");
      expect(r.failure?.message).toContain("--paid/--deny");
      expect(r.coverage.controls.refused).toBe(3);
      // It stopped at once — never scrolling on for its whole 120-decision budget.
      expect(r.transcript.length).toBeLessThan(10);
    },
    180_000,
  );
});

describe("#209 item 5 — body links are coverage; nav links are global navigation (one name)", () => {
  it(
    "a fully covered 2-page app whose links are in the page body is clean, exhausted",
    async () => {
      const r = await runCoverageMission({
        url: `${origin}/story`,
        allowlist: [origin],
        judge: quietJudge,
        gen: new FakeGenerationGateway({}),
        bounds: { maxActions: 10, maxDecisions: 10 },
        outDir: outDir(),
      });
      expect(r.coverage.sufficiency.shortfalls).toEqual([]);
      expect(r.outcome).toBe("exhausted");
      expect(r.missionOutcome).toBe("clean");
    },
    180_000,
  );

  it(
    "the same app with its links only in <nav>: outcome AND failure.kind insufficient-coverage, with a hint",
    async () => {
      const r = await runCoverageMission({
        url: `${origin}/docs`,
        allowlist: [origin],
        judge: quietJudge,
        gen: new FakeGenerationGateway({}),
        bounds: { maxActions: 10, maxDecisions: 10 },
        outDir: outDir(),
      });
      expect(r.missionOutcome).toBe("inconclusive");
      expect(r.outcome).toBe("insufficient-coverage");
      expect(r.failure?.kind).toBe("insufficient-coverage");
      expect(r.failure?.message).toContain("only global navigation");
      expect(r.failure?.message).toContain("to reach clean");
    },
    180_000,
  );
});

describe("#209 item 6 — every defect is in top-level defects", () => {
  it(
    "a coverage run's horizontal-overflow defect is in defects (and still in coverage.defects)",
    async () => {
      const r = await runCoverageMission({
        url: `${origin}/wide`,
        allowlist: [origin],
        judge: quietJudge,
        gen: new FakeGenerationGateway({}),
        bounds: { maxActions: 3, maxDecisions: 4 },
        overflow: { checkOverflow: true },
        outDir: outDir(),
      });
      expect(r.missionOutcome).toBe("defects-found");
      const overflow = r.coverage.defects.find((d) => d.kind === "horizontal-overflow");
      expect(overflow).toBeDefined();
      expect(r.defects).toContainEqual(expect.objectContaining({ kind: "horizontal-overflow", fingerprint: overflow!.fingerprint }));
      // The unified schema holds: every defect carries its 16-hex fingerprint and kind.
      expect(MissionResultSchema.safeParse(JSON.parse(JSON.stringify(r))).success).toBe(true);
    },
    180_000,
  );
});
