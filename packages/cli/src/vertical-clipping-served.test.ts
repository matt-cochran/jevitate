import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeGenerationGateway, type Answer, type JudgmentPort } from "@jevitate/ai-core";
import { MissionResultSchema } from "@jevitate/domain";
import { PlaywrightBrowserPort } from "@jevitate/playwright";
import { CLI_ADVERSARIAL_STRATEGIES, runAdversarialCliMission, runCoverageMission } from "./explore-api.js";
import { runUsabilityMission } from "./ux-api.js";
import { useSkippingTime } from "../../explore/src/testkit.js";

// #304: Node and page time skip idle waits (settle windows, hang ceilings, polls); assertions unchanged.
useSkippingTime({ per: "all" });

/**
 * #302 end to end, REAL Chromium at 375x812: the vertical-clipping signal is reported where the
 * horizontal-overflow one is — a defect in coverage and adversarial runs, a signal finding in the
 * usability review. `/` carries the issue's repro (a wrapped balance chip spilling above the page
 * top from a 56px header), a fixed-height `overflow: hidden` card that cuts its text off, and a
 * line-clamped teaser that truncates on purpose (never reported). `/clean` has only the teaser.
 */
// Layout-deterministic (CI fonts differ): every chip item takes a full row (flex-basis 100%), so the
// chip is always 6 rows x 20px = 120px in a 56px header and spills 32px above the page top,
// whatever the installed fonts' advance widths or ascent/descent.
const CHIP = ["1173.14", "credits", "balance", "10.02", "credits", "held"]
  .map((t) => `<span style="flex:0 0 100%;white-space:nowrap">${t}</span>`)
  .join("");
const LONG = "Your monthly report is ready. It covers usage, credits, invoices and every member who joined this month.";
const TEASER = `<p data-testid="teaser" style="width:200px;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden">${LONG}</p>`;
const page = (body: string): string =>
  `<!doctype html><html><head><meta name="viewport" content="width=device-width"></head><body style="margin:0;font:16px/20px monospace">${body}<button type="button" onclick="this.textContent='Done'">Refresh</button></body></html>`;
const PAGES: Record<string, string> = {
  "/": page(
    `<header style="height:56px;display:flex;align-items:center"><div data-testid="balance" style="display:flex;flex-wrap:wrap;width:120px;gap:0 4px">${CHIP}</div></header>` +
      `<div data-testid="card" style="height:40px;overflow:hidden;width:200px"><p style="margin:0">${LONG}</p></div>${TEASER}`,
  ),
  "/clean": page(TEASER),
};

let server: Server;
let origin: string;
let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "jev-302-"));
  server = createServer((req, res) => {
    const body = PAGES[(req.url ?? "").split("?")[0] ?? ""];
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
const outDir = (): string => join(dir, `run-${++n}`);
const MOBILE = { viewport: { width: 375, height: 812 } };

describe("#302 vertical clipping — where horizontal overflow is reported (served, real browser)", () => {
  it(
    "coverage: one vertical-clipping defect per clipped element (never the line-clamped teaser); none at /clean",
    async () => {
      const r = await runCoverageMission({
        url: `${origin}/`,
        allowlist: [origin],
        judge: quietJudge,
        gen: new FakeGenerationGateway({}),
        bounds: { maxActions: 3, maxDecisions: 4 },
        emulation: MOBILE,
        outDir: outDir(),
      });
      const clipped = r.coverage.defects.filter((d) => d.kind === "vertical-clipping");
      expect(clipped.map((d) => [d.clipping?.cause, d.clipping?.element.descriptor]).sort()).toEqual([
        ["above-page-top", "[data-testid=balance]"],
        ["overflow-hidden", "[data-testid=card]"],
      ]);
      expect(r.missionOutcome).toBe("defects-found");
      for (const d of clipped) expect(r.defects).toContainEqual(expect.objectContaining({ kind: "vertical-clipping", fingerprint: d.fingerprint }));
      expect(MissionResultSchema.safeParse(JSON.parse(JSON.stringify(r))).success).toBe(true);

      const clean = await runCoverageMission({
        url: `${origin}/clean`,
        allowlist: [origin],
        judge: quietJudge,
        gen: new FakeGenerationGateway({}),
        bounds: { maxActions: 2, maxDecisions: 3 },
        emulation: MOBILE,
        outDir: outDir(),
      });
      expect(clean.coverage.defects.filter((d) => d.kind === "vertical-clipping")).toEqual([]);
    },
    180_000,
  );

  it(
    "adversarial: a vertical-clipping hard signal is a defect",
    async () => {
      const r = await runAdversarialCliMission({
        seedUrl: `${origin}/`,
        allowlist: [origin],
        strategies: CLI_ADVERSARIAL_STRATEGIES,
        judgment: quietJudge,
        generation: new FakeGenerationGateway({}),
        bounds: { maxActions: 4, maxDecisions: 4 },
        emulation: MOBILE,
        outDir: outDir(),
      });
      // Both clipped elements' fingerprints are among the run's defect signals (grouped per step).
      const text = JSON.stringify(r.defects);
      expect(text).toContain("vertical-clipping");
      expect(text).toContain("[data-testid=balance]");
      expect(text).not.toContain("[data-testid=teaser]");
    },
    180_000,
  );

  it(
    "usability: a signal-vertical-clipping finding attributed to the element",
    async () => {
      const result = await runUsabilityMission({
        url: `${origin}/`,
        job: "check the balance",
        allowlist: [origin],
        appContext: { appClass: "admin", job: "check the balance" },
        judge: quietJudge,
        gen: new FakeGenerationGateway(),
        bounds: { maxDecisions: 1 },
        judgmentBudget: 2,
        minConfidence: 0,
        outDir: outDir(),
        emulation: MOBILE,
        browserPortFactory: () => new PlaywrightBrowserPort(),
      });
      const clipped = result.report!.findings.filter((f) => f.rubricItemId === "signal-vertical-clipping");
      expect(clipped.map((f) => f.observation).join("\n")).toContain("[data-testid=balance]");
      expect(clipped.map((f) => f.observation).join("\n")).toContain("[data-testid=card]");
      expect(clipped.every((f) => f.tier === "signal")).toBe(true);
    },
    120_000,
  );
});
