import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeGenerationGateway, type Answer, type JudgmentPort } from "@jevitate/ai-core";
import { MissionResultSchema } from "@jevitate/domain";
import { runExploration } from "./explore-api.js";

/**
 * #205 — the per-run memory ceiling, end to end on REAL Chromium: a served page that allocates
 * memory (64 MiB per 100ms, BOUNDED at 1.5 GiB so a failed detection cannot run away) is explored
 * under a 768 MiB browser-memory ceiling. The governor measures the run's browser tree, closes the
 * page with the reason, and the run ends `inconclusive` with failure kind `resource-limit` naming
 * the measured value and the ceiling — never `crashed`, never a defect or hang about the app.
 */
const PAGE = `<!doctype html><html><body><main><h1>Memory hog</h1>
  <button type="button" id="step" onclick="this.textContent = 'Step ' + (++window.n)">Step 0</button>
</main><script>
  window.n = 0;
  const hog = [];
  const t = setInterval(() => {
    if (hog.length >= 24) { clearInterval(t); return; }
    const a = new Uint8Array(64 * 1024 * 1024);
    a.fill(1);
    hog.push(a);
  }, 100);
</script></body></html>`;

let server: Server;
let origin: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    if ((req.url ?? "").startsWith("/hog")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(PAGE);
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** Keeps clicking the step button (progress every time), never `done`. */
const keepClicking: JudgmentPort = {
  async systemOne({ questions }) {
    const out: Record<string, Answer> = {};
    for (const [key, q] of Object.entries(questions)) {
      if (q.kind === "noul") out[key] = { kind: "noul", value: false, probability: 0.1 };
      else if (q.kind === "score") out[key] = { kind: "score", value: 0.1 };
      else out[key] = { kind: "choice", value: q.options.find((o) => o.startsWith("click")) ?? q.options[0] ?? "", confidence: 0.9 };
    }
    return out;
  },
};

const MiB = 1024 ** 2;

describe.runIf(process.platform === "linux" || process.platform === "darwin")("per-run memory ceiling (#205)", () => {
  it(
    "a page that allocates past the ceiling ends the run inconclusive with failure kind resource-limit",
    async () => {
      const outDir = await mkdtemp(join(tmpdir(), "jev-resource-limit-"));
      try {
        const r = await runExploration({
          url: `${origin}/hog`,
          goal: "reach step 1000",
          allowlist: [origin],
          judge: keepClicking,
          gen: new FakeGenerationGateway({}),
          successAssertion: { kind: "urlIncludes", text: "/never" },
          bounds: { maxDecisions: 60, maxActions: 60 },
          outDir,
          browser: { resources: { memoryCeilingBytes: 768 * MiB } },
        });
        const why = JSON.stringify({ failure: r.failure, resources: r.hostHealth.resources, steps: r.hostHealth.steps, defects: r.defects.length, hangs: r.hangs.length });
        expect(r.missionOutcome, why).toBe("inconclusive");
        expect(r.exitCode).toBe(2);
        expect(r.failure?.kind).toBe("resource-limit");
        expect(r.failure?.message).toMatch(/^resource limit: this run's browser processes used \d+ MiB \((pss|rss) of \d+ processes\), over the 768 MiB memory ceiling/);
        expect(r.defects).toEqual([]);
        expect(r.hangs).toEqual([]);
        const resources = r.hostHealth.resources!;
        expect(resources.resourceLimit).toMatchObject({ kind: "memory", ceilingBytes: 768 * MiB });
        expect(resources.resourceLimit!.measuredBytes).toBeGreaterThan(768 * MiB);
        expect(resources.memoryCeilingBytes).toBe(768 * MiB);
        expect(resources.peakBrowserMemoryBytes).toBeGreaterThan(768 * MiB);
        expect(MissionResultSchema.safeParse(JSON.parse(JSON.stringify(r))).success).toBe(true);
      } finally {
        await rm(outDir, { recursive: true, force: true });
      }
    },
    180_000,
  );
});
