import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeGenerationGateway, FakeJudgmentGateway } from "@jevitate/ai-core";
import { MissionResultSchema } from "@jevitate/domain";
import { consolidate } from "@jevitate/findings";
import { runCoverageMission } from "./explore-api.js";
import { loadRunFile } from "./report-api.js";

/**
 * #214 — Jev is advisory-only; independent code adjudicates. A coverage state flagged ONLY by the
 * `isDefect` judgment (`judgment-flagged-state`) is reported `advisory: true` — listed in `defects`
 * and `coverage.defects` with its repro Recording — but never makes the run `defects-found` (exit 1).
 * The same flagged state with a hard signal (an HTTP 500) still gates.
 */

let app: Server;
let origin: string;

const page = (saveUrl: string): string => `<!doctype html><html><body><main>
<h1>Profile</h1>
<button id="save" type="button">Save</button>
<p id="status"></p>
<script>
  document.getElementById("save").addEventListener("click", async () => {
    await fetch(${JSON.stringify(saveUrl)}, { method: "PUT", body: "{}" }).catch(() => {});
    document.getElementById("status").textContent = "Saved";
    history.pushState({}, "", location.pathname + "?saved=1");
  });
</script></main></body></html>`;

beforeAll(async () => {
  app = createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0] ?? "";
    if (path === "/ok") return void res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(page("/api/ok"));
    if (path === "/broken") return void res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(page("/api/broken"));
    if (path === "/api/ok") return void res.writeHead(200, { "content-type": "application/json" }).end("{}");
    if (path === "/api/broken") return void res.writeHead(500, { "content-type": "application/json" }).end('{"error":"boom"}');
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => app.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => app.close(() => resolve()));
});

/** Jev flags EVERY state it is asked about as a defect. */
const flagsEverything = (): FakeJudgmentGateway => new FakeJudgmentGateway({ isDefect: { kind: "noul", value: true, probability: 0.97 } });

describe("coverage: a judgment-only flag is advisory, never gating (#214)", () => {
  it(
    "the only finding is a judgment-flagged state — listed advisory with its repro, never defects-found",
    async () => {
      const outDir = await mkdtemp(join(tmpdir(), "jev-214-ok-"));
      try {
        const r = await runCoverageMission({ url: `${origin}/ok`, allowlist: [origin], judge: flagsEverything(), gen: new FakeGenerationGateway(), outDir });
        const flagged = r.defects.filter((d) => d.kind === "judgment-flagged-state");
        expect(flagged.length).toBeGreaterThan(0);
        expect(flagged.every((d) => (d as { advisory?: true }).advisory === true)).toBe(true);
        expect(r.defects.filter((d) => d.kind !== "judgment-flagged-state")).toEqual([]);
        // Still in coverage.defects, with the repro Recording verify-fix replays.
        const cov = r.coverage.defects.filter((d) => d.kind === "judgment-flagged-state");
        expect(cov.length).toBe(flagged.length);
        expect(cov.every((d) => d.advisory === true && d.recording.pages.length > 0)).toBe(true);
        expect(r.missionOutcome).not.toBe("defects-found");
        expect(["clean", "inconclusive"]).toContain(r.missionOutcome);
        expect(r.exitCode).not.toBe(1);
        expect(MissionResultSchema.safeParse(JSON.parse(JSON.stringify(r))).success).toBe(true);
        // The findings every consumer (`check`, `report`) reads: advisory, never hard.
        const run = loadRunFile(r.resultPath);
        expect(run).not.toBeNull();
        const findings = consolidate([run!]);
        expect(findings.length).toBeGreaterThan(0);
        expect(findings.every((f) => f.severity === "advisory")).toBe(true);
      } finally {
        await rm(outDir, { recursive: true, force: true });
      }
    },
    120_000,
  );

  it(
    "the same flagged state with a hard signal (an HTTP 500) still gates — defects-found, exit 1",
    async () => {
      const outDir = await mkdtemp(join(tmpdir(), "jev-214-broken-"));
      try {
        const r = await runCoverageMission({ url: `${origin}/broken`, allowlist: [origin], judge: flagsEverything(), gen: new FakeGenerationGateway(), outDir });
        expect(r.defects.some((d) => d.kind === "http-5xx" && (d as { advisory?: true }).advisory !== true)).toBe(true);
        expect(r.defects.some((d) => d.kind === "judgment-flagged-state" && (d as { advisory?: true }).advisory === true)).toBe(true);
        expect(r.missionOutcome).toBe("defects-found");
        expect(r.exitCode).toBe(1);
      } finally {
        await rm(outDir, { recursive: true, force: true });
      }
    },
    120_000,
  );
});
