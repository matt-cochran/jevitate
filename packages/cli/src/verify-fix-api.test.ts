import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeGenerationGateway, FakeJudgmentGateway } from "@jevitate/ai-core";
import { runAdversarialCliMission } from "./explore-api.js";
import { runVerifyFix, VerifyFixInputError } from "./verify-fix-api.js";
import { buildMcpTools } from "./mcp-api.js";
import { buildProgram } from "./program.js";
import { currentEngineInfo } from "./engine.js";
import { PlaywrightBrowserPort } from "@jevitate/playwright";
import type { ProfileManager } from "@jevitate/daemon";

/**
 * Owner ruling 2 — the verify-fix path, end to end through the CLI surface: an adversarial run
 * persists its typed result; `runVerifyFix` (the `jevitate verify-fix` / MCP `verify_fix`
 * backend) replays a defect from it in a fresh browser.
 */

const state = { broken: true };
let server: Server;
let origin: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === "/api/data") {
      res.writeHead(state.broken ? 500 : 200, { "content-type": "application/json" }).end("{}");
      return;
    }
    if (req.url === "/home") {
      res
        .writeHead(200, { "content-type": "text/html" })
        .end(`<!doctype html><html><body><button type="button">Go</button><script>fetch("/api/data")</script></body></html>`);
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

describe("verify-fix — CLI surface", () => {
  it(
    "replays a persisted defect: still reproduces (exit 1), then fixed (exit 0) once the server is fixed",
    async () => {
      const outDir = await mkdtemp(join(tmpdir(), "jev-verify-"));
      try {
        state.broken = true;
        const run = await runAdversarialCliMission({
          seedUrl: `${origin}/home`,
          allowlist: [origin],
          strategies: ["nav-during-pending"],
          bounds: { maxDecisions: 1 },
          judgment: new FakeJudgmentGateway({ looksBroken: { kind: "noul", value: false, probability: 0 } }),
          generation: new FakeGenerationGateway(),
          outDir,
          nowIso: () => "2026-09-23T00:00:00.000Z",
          // A real Chromium (this file runs in the vitest `browser` project).
          browserPortFactory: () => new PlaywrightBrowserPort(),
        });
        expect(run.outcome).toBe("defects-found");
        expect(run.exitCode).toBe(1);
        const defect = run.defects[0];
        if (defect === undefined) throw new Error("expected a defect");
        expect(run.target).toEqual({ seedUrl: `${origin}/home`, allowlist: [origin] });

        const still = await runVerifyFix({ resultPath: run.resultPath, fingerprint: defect.fingerprint, settleCeilingMs: 3_000 });
        expect(still).toMatchObject({ verdict: "still-reproduces", exitCode: 1, title: "HTTP 500 from /api/data" });

        state.broken = false;
        const fixed = await runVerifyFix({ resultPath: run.resultPath, fingerprint: defect.fingerprint, settleCeilingMs: 3_000 });
        expect(fixed).toMatchObject({ verdict: "fixed", exitCode: 0 });

        // The CLI command surfaces the same verdict and exit code.
        state.broken = true;
        const lines: string[] = [];
        const program = buildProgram({ profiles: {} as unknown as ProfileManager });
        program.exitOverride();
        program.configureOutput({ writeOut: (s) => lines.push(s), writeErr: () => undefined });
        await program.parseAsync(["node", "jevitate", "verify-fix", "--result", run.resultPath, "--fingerprint", defect.fingerprint, "--json"]);
        expect(JSON.parse(lines.join(""))).toMatchObject({ ok: true, data: { verdict: "still-reproduces", engine: currentEngineInfo() } });
        expect(process.exitCode).toBe(1);
        process.exitCode = 0;
      } finally {
        await rm(outDir, { recursive: true, force: true });
      }
    },
    180_000,
  );

  it("refuses unusable input as a typed error, never as 'fixed'", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jev-verify-bad-"));
    try {
      await expect(runVerifyFix({ resultPath: join(dir, "missing.result.json"), fingerprint: "0".repeat(16) })).rejects.toBeInstanceOf(
        VerifyFixInputError,
      );
      const p = join(dir, "x.result.json");
      await writeFile(p, JSON.stringify({ missionOutcome: "clean", exitCode: 0, result: { recording: {} } }));
      await expect(runVerifyFix({ resultPath: p, fingerprint: "0".repeat(16) })).rejects.toThrow(/replay target/);

      const lines: string[] = [];
      const program = buildProgram({ profiles: {} as unknown as ProfileManager });
      program.exitOverride();
      program.configureOutput({ writeOut: (s) => lines.push(s), writeErr: () => undefined });
      await program.parseAsync(["node", "jevitate", "verify-fix", "--result", join(dir, "nope.json"), "--fingerprint", "0".repeat(16)]);
      expect(JSON.parse(lines.join(""))).toMatchObject({ ok: false, error: { code: "E_VERIFY_FIX_INPUT" } });
      expect(process.exitCode).toBe(2);
      process.exitCode = 0;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("findings → issue drafts and filing (owner ruling 3) — fake filer only", () => {
  it(
    "writes a redacted draft per defect next to the Recording; files ONLY when enabled with a repo",
    async () => {
      const outDir = await mkdtemp(join(tmpdir(), "jev-filing-e2e-"));
      try {
        state.broken = true;
        const filed: Array<{ repo: string; title: string; body: string }> = [];
        let filersMade = 0;
        const fakeFiler = () => {
          filersMade += 1;
          return {
            findOpenByMarker: async () => null,
            create: async (repo: string, issue: { title: string; body: string }) => {
              filed.push({ repo, title: issue.title, body: issue.body });
              return { number: 1, url: `https://example.test/${repo}/issues/1` };
            },
            comment: async (_repo: string, n: number) => ({ number: n, url: "u" }),
          };
        };
        const run = (filing: { enabled: boolean; jevitateRepo: string; targetRepo?: string }, stamp: string) =>
          runAdversarialCliMission({
            seedUrl: `${origin}/home`,
            allowlist: [origin],
            strategies: ["nav-during-pending"],
            bounds: { maxDecisions: 1 },
            judgment: new FakeJudgmentGateway({ looksBroken: { kind: "noul", value: false, probability: 0 } }),
            generation: new FakeGenerationGateway(),
            outDir,
            nowIso: () => stamp,
            browserPortFactory: () => new PlaywrightBrowserPort(),
            // A --secret that occurs in the defect's own evidence (the failing endpoint's path).
            secrets: ["api/data"],
            filing,
            issueFiler: fakeFiler,
          });

        const disabled = await run({ enabled: false, jevitateRepo: "o/j", targetRepo: "acme/app" }, "2026-09-23T00:00:00.000Z");
        expect(disabled.outcome).toBe("defects-found");
        expect(filersMade).toBe(0);
        expect(disabled.issues.drafts).toHaveLength(1);
        const draftText = await readFile(disabled.issues.drafts[0]?.path ?? "", "utf8");
        expect(draftText).toContain("## Steps to reproduce");
        expect(draftText).not.toContain("api/data");
        expect(disabled.issues.filing[0]?.outcomes[0]).toMatchObject({ status: "draft-only", reason: "filing is disabled" });

        const enabled = await run({ enabled: true, jevitateRepo: "o/j", targetRepo: "acme/app" }, "2026-09-23T00:00:01.000Z");
        expect(filersMade).toBe(1);
        expect(filed.map((f) => f.repo)).toEqual(["acme/app"]);
        expect(filed[0]?.body).not.toContain("api/data");
        expect(enabled.issues.filing[0]?.outcomes[0]).toMatchObject({ status: "filed", action: "created", repo: "acme/app" });
      } finally {
        await rm(outDir, { recursive: true, force: true });
      }
    },
    180_000,
  );
});

describe("verify-fix — MCP surface", () => {
  it("replays by result id + fingerprint only; inconclusive is an error result, never a pass", async () => {
    const seen: string[] = [];
    const tools = buildMcpTools({
      journeysDir: "/nonexistent",
      recordingsDir: "/recs",
      verifyFix: async ({ resultPath, fingerprint }) => {
        seen.push(resultPath);
        return {
          verdict: fingerprint.startsWith("a") ? "still-reproduces" : "inconclusive",
          fingerprint,
          observedFingerprints: [],
          replay: { outcome: "completed" },
          reason: "r",
          exitCode: fingerprint.startsWith("a") ? 1 : 2,
        };
      },
    });
    const tool = tools.find((t) => t.name === "verify_fix");
    if (tool === undefined) throw new Error("verify_fix not served");
    const id = "adversarial-2026-09-23T00-00-00-000Z";

    const still = await tool.handler({ id, fingerprint: "a".repeat(16) });
    expect(still.isError).toBeUndefined();
    expect(JSON.parse(still.content[0]?.text ?? "")).toMatchObject({ status: "still-reproduces", exitCode: 1 });
    expect(seen).toEqual([join("/recs", `${id}.result.json`)]);

    const inconclusive = await tool.handler({ id, fingerprint: "b".repeat(16) });
    expect(inconclusive.isError).toBe(true);

    const bad = await tool.handler({ id: "../x", fingerprint: "a".repeat(16), recording: { pages: [] } });
    expect(bad.isError).toBe(true);
    expect(JSON.parse(bad.content[0]?.text ?? "")).toMatchObject({ error: "invalid_args" });
    expect(seen).toHaveLength(2);
  });
});
