import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeGenerationGateway, type Answer, type JudgmentPort } from "@jevitate/ai-core";
import { startServer } from "@jevitate/example-site";
import { runUsabilityMission } from "./ux-api.js";

/**
 * #142 follow-up (item 1) — `--strategy usability` supports `--log-source`/`--log-defect` too: a
 * server-log line attaches to a usability step exactly like every other strategy, and a
 * `server-log` defect is reported in the result — but stays advisory (never flips
 * `missionOutcome`/`exitCode`), the same rule every other UX finding follows.
 */

let site: { url: string; close(): Promise<void> };
beforeAll(async () => {
  site = await startServer();
});
afterAll(async () => {
  await site.close();
});
afterEach(() => {
  delete process.env.EXAMPLE_SITE_LOG;
});

/** Always answers with the FIRST offered option, at low confidence — the same "benign" shape
 *  `usability-hang-served.test.ts` uses to reliably click the page's first (only) control. */
const firstOptionJudge: JudgmentPort = {
  async systemOne({ questions }) {
    const out: Record<string, Answer> = {};
    for (const [key, q] of Object.entries(questions)) {
      if (q.kind === "noul") out[key] = { kind: "noul", value: false, probability: 0.1 };
      else if (q.kind === "score") out[key] = { kind: "score", value: 0.1 };
      else out[key] = { kind: "choice", value: q.options[0] ?? "", confidence: 0.1 };
    }
    return out;
  },
};

describe("usability + --log-source (#142 follow-up)", () => {
  it(
    "attaches a server-log line to a usability step and reports a server-log defect, without gating the (advisory) outcome",
    async () => {
      const outDir = await mkdtemp(join(tmpdir(), "jev-usability-server-log-"));
      const logFile = join(await mkdtemp(join(tmpdir(), "jev-usability-server-log-file-")), "app.log");
      process.env.EXAMPLE_SITE_LOG = logFile;
      try {
        const result = await runUsabilityMission({
          url: `${site.url}/server-log-mission/page`,
          job: "look around",
          allowlist: [site.url],
          appContext: { appClass: "consumer", job: "look around" },
          judge: firstOptionJudge,
          gen: new FakeGenerationGateway(),
          judgmentBudget: 1,
          minConfidence: 0,
          outDir,
          bounds: { maxDecisions: 1, maxActions: 1 },
          // A matcher of "warn" catches EITHER button (level >= warn includes error too) — the
          // control the low-confidence judge happens to click first is not this test's concern.
          serverLog: {
            sources: [{ kind: "file", path: logFile, raw: `file:${logFile}` }],
            logDefect: [{ kind: "level", level: "warn", raw: "warn" }],
            drainMs: 1500,
          },
        });

        // Advisory: a server-log defect never turns a UX review non-clean by itself.
        expect(["clean", "inconclusive", "crashed"]).toContain(result.missionOutcome);
        expect(result.serverLogs).toBeDefined();
        expect(result.serverLogs?.sources[0]?.opened).toBe(true);

        // The page has only the two log-emitting buttons; the low-confidence judge always picks the
        // first offered candidate, so its one allotted action reliably clicks one of them.
        expect(result.serverLogs?.attachedLines).toBeGreaterThan(0);
        expect(result.serverLogDefects).toBeDefined();
        expect(result.serverLogDefects!.length).toBeGreaterThan(0);
        expect(result.serverLogDefects![0]!.kind).toBe("server-log");
      } finally {
        await rm(outDir, { recursive: true, force: true });
      }
    },
    120_000,
  );
});
