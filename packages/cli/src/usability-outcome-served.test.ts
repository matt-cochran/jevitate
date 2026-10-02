import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeGenerationGateway, type Answer, type JudgmentPort } from "@jevitate/ai-core";
import { runUsabilityMission } from "./ux-api.js";

/**
 * #209 item 1 — a usability review whose job was never completed must not read `clean`: its loop
 * gave up (runOutcome `incomplete`), so its silence about the screens a user who finished the job
 * would have seen proves nothing. It is `inconclusive` (`failure.kind: "job-incomplete"`). A review
 * whose job WAS completed (a grounded `done`) is still `clean` — UX findings stay advisory.
 * Served page, real Chromium, deterministic fake judges.
 */

let server: Server;
let origin: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0] ?? "";
    if (path === "/editor") {
      // The minimap is broken: clicking a block does nothing.
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(`<!doctype html><html><body>
        <h1>Editor</h1>
        <nav aria-label="Minimap"><button type="button">Block 1</button><button type="button">Block 2</button><button type="button">Block 3</button></nav>
        <p>Block 1 content</p>
      </body></html>`);
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (addr === null || typeof addr === "string") throw new Error("no port");
  origin = `http://127.0.0.1:${(addr satisfies AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** Proposes `op` for the action question; answers every goal/advisory noul with `goalMet`. */
function judge(op: "blocked" | "done", goalMet: number): JudgmentPort {
  return {
    async systemOne({ questions }) {
      const out: Record<string, Answer> = {};
      for (const [key, q] of Object.entries(questions)) {
        if (q.kind === "noul") out[key] = { kind: "noul", value: goalMet >= 0.5, probability: goalMet };
        else if (q.kind === "score") out[key] = { kind: "score", value: 0.1 };
        else if (key === "action") out[key] = { kind: "choice", value: q.options.includes(op) ? op : (q.options[0] ?? ""), confidence: 0.9 };
        else out[key] = { kind: "choice", value: q.options[0] ?? "", confidence: 0.1 };
      }
      return out;
    },
  };
}

async function review(j: JudgmentPort) {
  const outDir = await mkdtemp(join(tmpdir(), "jev-usability-outcome-"));
  try {
    return await runUsabilityMission({
      url: `${origin}/editor`,
      job: "Use the minimap to jump to block 3",
      allowlist: [origin],
      appContext: { appClass: "consumer", job: "Use the minimap to jump to block 3" },
      judge: j,
      gen: new FakeGenerationGateway(),
      judgmentBudget: 1,
      minConfidence: 0,
      bounds: { maxDecisions: 3 },
      outDir,
    });
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
}

describe("#209 — a usability review whose job failed is never clean", () => {
  it(
    "the job was never completed (the model gave up): inconclusive, failure.kind job-incomplete",
    async () => {
      const result = await review(judge("blocked", 0.1));
      expect(result.outcome.status).toBe("incomplete");
      expect(result.missionOutcome).toBe("inconclusive");
      expect(result.exitCode).toBe(2);
      // #237: this model gives up before trying anything — the run says so precisely (too little
      // exploration), still inconclusive and never clean.
      expect(result.failure?.kind).toBe("insufficient-coverage");
      expect(result.failure?.message).toMatch(/gave up before trying any of the page's \d+ controls/);
    },
    240_000,
  );

  it(
    "the job was completed (a grounded done): the review's verdict is not made inconclusive by it",
    async () => {
      const result = await review(judge("done", 0.95));
      expect(result.outcome.status).toBe("completed");
      expect(result.failure?.kind).not.toBe("job-incomplete");
      expect(result.missionOutcome).not.toBe("inconclusive");
    },
    240_000,
  );
});
