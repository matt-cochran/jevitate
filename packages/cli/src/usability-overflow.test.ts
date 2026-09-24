import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeGenerationGateway, type Answer, type JudgmentPort } from "@jevitate/ai-core";
import { PlaywrightBrowserPort } from "@jevitate/playwright";
import { runUsabilityMission } from "./ux-api.js";

/**
 * #149 — the horizontal-overflow hard signal as a `tier: "signal"` UxFinding during
 * `explore --strategy usability`: pure DOM geometry (`@jevitate/explore`'s `detectOverflow`),
 * computed live per observed screen, never a model judgment.
 */

const WIDE = `<!doctype html><html><body style="margin:0;padding:0">
  <h1>Settings</h1>
  <table data-testid="wide" style="min-width:600px"><tbody><tr><td>k_live_1</td><td>Production key</td></tr></tbody></table>
  <button type="button">Acknowledge</button>
</body></html>`;

let server: Server;
let origin: string;

beforeAll(async () => {
  server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(WIDE);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** Answers every UX-rubric question benignly and picks the first offered candidate action. */
const benignJudge: JudgmentPort = {
  async systemOne({ questions }) {
    const out: Record<string, Answer> = {};
    for (const [key, q] of Object.entries(questions)) {
      if (q.kind === "noul") out[key] = { kind: "noul", value: false, probability: 0.1 };
      else if (q.kind === "score") out[key] = { kind: "score", value: 0.1 };
      else out[key] = { kind: "choice", value: q.options[0] ?? "", confidence: 0.5 };
    }
    return out;
  },
};

describe("runUsabilityMission — horizontal-overflow signal finding (#149)", () => {
  it("at a 375px viewport, reports a signal-horizontal-overflow finding attributed to [data-testid=wide]", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "jev-usability-overflow-"));
    const result = await runUsabilityMission({
      url: origin,
      job: "acknowledge the notice",
      allowlist: [origin],
      appContext: { appClass: "admin", job: "acknowledge the notice" },
      judge: benignJudge,
      gen: new FakeGenerationGateway(),
      bounds: { maxDecisions: 1 },
      judgmentBudget: 2,
      minConfidence: 0,
      outDir,
      emulation: { viewport: { width: 375, height: 812 } },
      browserPortFactory: () => new PlaywrightBrowserPort(),
    });
    const findings = result.report!.findings;
    const finding = findings.find((f) => f.rubricItemId === "signal-horizontal-overflow");
    expect(finding, JSON.stringify(findings.map((f) => f.rubricItemId))).toBeDefined();
    expect(finding!.tier).toBe("signal");
    expect(finding!.observation).toContain("[data-testid=wide]");
    expect(finding!.signal!.steps.length).toBeGreaterThan(0);
  }, 30_000);

  it("at a 1280px viewport, no horizontal-overflow finding is reported", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "jev-usability-overflow-clean-"));
    const result = await runUsabilityMission({
      url: origin,
      job: "acknowledge the notice",
      allowlist: [origin],
      appContext: { appClass: "admin", job: "acknowledge the notice" },
      judge: benignJudge,
      gen: new FakeGenerationGateway(),
      bounds: { maxDecisions: 1 },
      judgmentBudget: 2,
      minConfidence: 0,
      outDir,
      browserPortFactory: () => new PlaywrightBrowserPort(),
    });
    const findings = result.report!.findings;
    expect(findings.find((f) => f.rubricItemId === "signal-horizontal-overflow")).toBeUndefined();
  }, 30_000);
});
