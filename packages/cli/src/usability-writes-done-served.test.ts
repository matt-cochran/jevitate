import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeGenerationGateway, type Answer, type JudgmentPort } from "@jevitate/ai-core";
import { GOAL_MET_QUESTION } from "@jevitate/explore";
import { runUsabilityMission } from "./ux-api.js";

/**
 * #514 — a usability job ("import the attached CSV of contacts", Autopilot CRM) whose writes all
 * succeeded, but the same rows had been imported before, so the page looked unchanged and `done` was
 * rejected 3 times (p 0.46 / 0.24 / 0.22) → `job-incomplete`. Served page, real Chromium, a judge
 * that never sees the goal met on the page.
 */

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Contacts</title></head>
<body><h1>Contacts</h1><ul><li>Ada Lovelace</li><li>Grace Hopper</li></ul>
<button type="button" id="import">Import contacts</button>
<script>document.getElementById("import").addEventListener("click", () => {
  fetch("/api/import", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
});</script></body></html>`;

let server: Server;
let origin: string;
beforeAll(async () => {
  server = createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0] ?? "";
    if (path === "/api/import" && req.method === "POST") {
      req.resume();
      req.on("end", () => res.writeHead(201, { "content-type": "application/json" }).end('{"imported":0}'));
      return;
    }
    if (path === "/contacts") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(PAGE);
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

// Contacts: [0] Import contacts.
const STEPS = ["click:0", "done"];

/** Plays click Import → done; the page judgment says the goal is not observably met (p 0.24). */
function unchangedPageJudge(): JudgmentPort {
  let i = 0;
  return {
    async systemOne({ questions }) {
      const out: Record<string, Answer> = {};
      for (const [key, q] of Object.entries(questions)) {
        if (key === "action" && q.kind === "choice") {
          const want = STEPS[Math.min(i, STEPS.length - 1)]!;
          i += 1;
          out[key] = { kind: "choice", value: q.options.includes(want) ? want : (q.options[0] ?? ""), confidence: 0.9 };
        } else if (key === GOAL_MET_QUESTION) out[key] = { kind: "noul", value: false, probability: 0.24 };
        else if (q.kind === "noul") out[key] = { kind: "noul", value: false, probability: 0.1 };
        else if (q.kind === "score") out[key] = { kind: "score", value: 0.1 };
        else out[key] = { kind: "choice", value: q.options[0] ?? "", confidence: 0.1 };
      }
      return out;
    },
  };
}

describe("#514 — a usability job whose writes succeeded on an unchanged page", () => {
  it(
    "the job ends complete, its done accepted on the succeeded writes with the repeat-data note",
    async () => {
      const outDir = await mkdtemp(join(tmpdir(), "jev-usability-writes-"));
      try {
        const result = await runUsabilityMission({
          url: `${origin}/contacts`,
          job: "Import the contacts.",
          allowlist: [origin],
          appContext: { appClass: "consumer", job: "Import the contacts." },
          judge: unchangedPageJudge(),
          gen: new FakeGenerationGateway(),
          judgmentBudget: 1,
          minConfidence: 0,
          bounds: { maxDecisions: 6 },
          outDir,
        });
        expect({ outcome: result.outcome, failure: result.failure?.kind }).toEqual({
          outcome: { status: "completed", verifiedBy: "succeeded-writes", note: "the job's writes succeeded; the page shows no change (repeat data?)" },
          failure: undefined,
        });
      } finally {
        await rm(outDir, { recursive: true, force: true });
      }
    },
    240_000,
  );
});
