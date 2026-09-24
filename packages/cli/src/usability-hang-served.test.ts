import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeGenerationGateway, type Answer, type JudgmentPort } from "@jevitate/ai-core";
import { runUsabilityMission } from "./ux-api.js";

/**
 * #126 item 2 — a usability run that stops because of a hang must never report
 * `missionOutcome: clean`. It is mapped through the same hang/intermittent/inconclusive rule a
 * goal mission uses, with the hang reproduced in fresh contexts.
 */

let server: Server;
let origin: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0] ?? "";
    if (path === "/seed") {
      res.writeHead(200, { "content-type": "text/html" }).end(`<!doctype html><html><body>
        <h1>Seed</h1>
        <button type="button">Refresh</button>
        <script>fetch("/api/gate");</script>
      </body></html>`);
      return;
    }
    // /api/gate (and anything else): never answered — the page never settles.
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (addr === null || typeof addr === "string") throw new Error("no port");
  origin = `http://127.0.0.1:${(addr satisfies AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const benignJudge: JudgmentPort = {
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

describe("#126 — a usability run that stops on a hang is never reported clean", () => {
  it(
    "a hang on the seed maps missionOutcome through hang/intermittent/inconclusive, never clean",
    async () => {
      const outDir = await mkdtemp(join(tmpdir(), "jev-usability-hang-"));
      try {
        const result = await runUsabilityMission({
          url: `${origin}/seed`,
          job: "look around",
          allowlist: [origin],
          appContext: { appClass: "consumer", job: "look around" },
          judge: benignJudge,
          gen: new FakeGenerationGateway(),
          judgmentBudget: 1,
          minConfidence: 0,
          outDir,
          // The default long-poll auto-detection (5s) would otherwise reclassify the never-answered
          // request as a background long-poll on this interactive page before the (default) hang
          // request-bound fires — disable it so the genuine hang is classified as one.
          target: { settle: { longPollMs: 999_999 } },
        });
        expect(result.stop).toBe("hang");
        expect(result.missionOutcome).not.toBe("clean");
        expect(["hang", "intermittent", "inconclusive"]).toContain(result.missionOutcome);
        expect(result.hang).toBeDefined();
        expect(result.hang!.hangKind).toBe("request-pending");
      } finally {
        await rm(outDir, { recursive: true, force: true });
      }
    },
    120_000,
  );
});
