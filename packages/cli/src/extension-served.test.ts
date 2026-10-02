import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeGenerationGateway, FakeJudgmentGateway, type Answer, type JudgmentPort } from "@jevitate/ai-core";
import { ProfileManager } from "@jevitate/daemon";
import { PlaywrightBrowserPort, extensionOrigin, readUnpackedExtension } from "@jevitate/playwright";
import { RecordingSchema } from "@jevitate/recording";
import { buildProgram } from "./program.js";
import { runAdversarialCliMission } from "./explore-api.js";
import { runVerifyFix, VerifyFixInputError } from "./verify-fix-api.js";
import { useSkippingTime } from "../../explore/src/testkit.js";

// #304: Node and page time skip idle waits (settle windows, hang ceilings, polls); assertions unchanged.
useSkippingTime({ per: "all" });

/**
 * #256 end to end in real Chromium (headless — the full Chromium build in new-headless mode; the
 * headless shell cannot load extensions): `explore --extension <dir> --url chrome-extension://<id>/…`
 * drives the extension's side panel page to its goal and records the extension on the Recording;
 * a finding recorded with an extension replays (verify-fix) only under that same build.
 * Skipped ONLY when the full Chromium build is not installed.
 */

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "playwright", "test-fixtures", "extension-mv3");
const FULL_CHROMIUM = (() => {
  try {
    return existsSync(chromium.executablePath());
  } catch {
    return false;
  }
})();

/** Plays a fixed sequence in decide()'s candidate-action format: `<op>:<index>` or a bare op. */
class ScriptedJudge implements JudgmentPort {
  #i = 0;
  constructor(private readonly seq: ReadonlyArray<{ op: string; target?: string }>) {}
  async systemOne(): Promise<Record<string, Answer>> {
    const cur = this.seq[Math.min(this.#i, this.seq.length - 1)];
    this.#i += 1;
    if (cur === undefined) throw new Error("ScriptedJudge: empty script");
    return { action: { kind: "choice", value: cur.target !== undefined ? `${cur.op}:${cur.target}` : cur.op, confidence: 0.9 } };
  }
}

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
      res.writeHead(200, { "content-type": "text/html" }).end(`<!doctype html><html><body><button type="button">Go</button><script>fetch("/api/data")</script></body></html>`);
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

describe.skipIf(!FULL_CHROMIUM)("#256 --extension (served, real Chromium, headless)", () => {
  const ext = readUnpackedExtension(FIXTURE);
  const identity = { id: ext.id, name: "Jevitate Fixture Extension", version: "1.2.3" };

  it(
    "explore drives the extension's side panel page to its goal and records the extension on the Recording",
    async () => {
      const outDir = await mkdtemp(join(tmpdir(), "jev-ext-explore-"));
      try {
        const lines: string[] = [];
        const program = buildProgram({
          profiles: new ProfileManager("/unused"),
          explore: {
            judge: new ScriptedJudge([{ op: "click", target: "0" }, { op: "done" }]),
            gen: new FakeGenerationGateway(),
            browserPortFactory: () => new PlaywrightBrowserPort(),
          },
        });
        program.configureOutput({ writeOut: (s) => lines.push(s) });
        program.exitOverride();
        await program.parseAsync(
          [
            "explore",
            "--extension",
            FIXTURE,
            "--url",
            `${extensionOrigin(ext.id)}/sidepanel.html`,
            "--goal",
            "give consent in the side panel",
            "--success",
            "textIncludes:css=#status|consent given",
            "--out",
            outDir,
            "--json",
          ],
          { from: "user" },
        );
        const parsed = JSON.parse(lines.join(""));
        expect(parsed.ok).toBe(true);
        expect(parsed.data.outcome).toBe("succeeded");
        expect(parsed.data.finalUrl).toBe(`${extensionOrigin(ext.id)}/sidepanel.html`);
        const recording = RecordingSchema.parse(JSON.parse(await readFile(parsed.data.recordingPaths[0], "utf8")));
        expect(recording.site).toBe(extensionOrigin(ext.id));
        expect(recording.extensions).toEqual([identity]);
        // The result's own Recording carries it too (schemaVersion 1, additive).
        expect(parsed.data.recording.extensions).toEqual([identity]);
      } finally {
        await rm(outDir, { recursive: true, force: true });
      }
    },
    120_000,
  );

  it(
    "a finding recorded with an extension: verify-fix without it (or with another build) is refused before any browser; with it, it replays",
    async () => {
      const outDir = await mkdtemp(join(tmpdir(), "jev-ext-verify-"));
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
          nowIso: () => "2026-10-01T00:00:00.000Z",
          browser: { extensions: [ext] },
          browserPortFactory: () => new PlaywrightBrowserPort(),
        });
        const defect = run.defects[0];
        if (defect === undefined) throw new Error("expected a defect");
        const persisted = JSON.parse(await readFile(run.resultPath, "utf8"));
        expect(persisted.result.recording.extensions).toEqual([identity]);

        const refused = await runVerifyFix({ resultPath: run.resultPath, fingerprint: defect.fingerprint }).catch((e: unknown) => e);
        expect(refused).toBeInstanceOf(VerifyFixInputError);
        expect((refused as Error).message).toMatch(/recorded with extensions Jevitate Fixture Extension@1\.2\.3 .* but this run loads none/);

        const otherBuild = await runVerifyFix({
          resultPath: run.resultPath,
          fingerprint: defect.fingerprint,
          browser: { extensions: [{ ...ext, version: "1.2.4" }] },
        }).catch((e: unknown) => e);
        expect(otherBuild).toBeInstanceOf(VerifyFixInputError);

        // The CLI: the same refusal is a usage error (exit 64).
        const lines: string[] = [];
        const program = buildProgram({ profiles: new ProfileManager("/unused"), explore: { browserPortFactory: () => new PlaywrightBrowserPort() } });
        program.configureOutput({ writeOut: (s) => lines.push(s), writeErr: () => undefined });
        program.exitOverride();
        const saved = process.exitCode;
        try {
          await program.parseAsync(["verify-fix", defect.fingerprint, "--result", run.resultPath, "--json"], { from: "user" });
          expect(process.exitCode).toBe(64);
        } finally {
          process.exitCode = saved;
        }
        expect(JSON.parse(lines.join("")).error.message).toMatch(/recorded with extensions/);

        const replayed = await runVerifyFix({ resultPath: run.resultPath, fingerprint: defect.fingerprint, settleCeilingMs: 3_000, browser: { extensions: [ext] } });
        expect(replayed.verdict).toBe("still-reproduces");
      } finally {
        await rm(outDir, { recursive: true, force: true });
      }
    },
    180_000,
  );
});
