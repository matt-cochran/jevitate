import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeGenerationGateway, type Answer, type JudgmentPort } from "@jevitate/ai-core";
import { runExploration } from "./explore-api.js";
import { formatMissionHuman } from "./cli-output.js";

/**
 * #303 `--action-deltas` through the CLI's goal runner (real Chromium): ON, every acted step's
 * `delta` is in the result's transcript, the persisted transcript and the Recording, the result
 * carries `actionDeltas`, and the human output lists them; OFF (the default), none of it.
 */
let server: Server;
let origin: string;
beforeAll(async () => {
  server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" }).end(
      `<!doctype html><html><body><main><h1>Profile</h1><button type="button" onclick="document.getElementById('st').textContent='Saved'">Save</button><div role="status" id="st"></div></main></body></html>`,
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** Clicks the first offered target, then proposes `done`, which the check accepts. */
function judge(): JudgmentPort {
  let n = 0;
  return {
    async systemOne({ questions }) {
      const out: Record<string, Answer> = {};
      for (const [name, q] of Object.entries(questions)) {
        if (q.kind === "choice" && name === "action") {
          const click = q.options.find((o) => o.startsWith("click:"));
          out[name] = { kind: "choice", value: n++ === 0 && click !== undefined ? click : "done", confidence: 1 };
        } else if (q.kind === "choice") out[name] = { kind: "choice", value: q.options[0]!, confidence: 1 };
        else if (q.kind === "noul") out[name] = { kind: "noul", value: false, probability: 0 };
        else out[name] = { kind: "score", value: 0 };
      }
      return out;
    },
  };
}

async function run(actionDeltas: boolean) {
  const outDir = await mkdtemp(join(tmpdir(), "jev-deltas-"));
  try {
    const result = await runExploration({
      url: `${origin}/`,
      goal: "save the profile",
      successAssertion: { kind: "visible", target: { text: "Saved" } },
      allowlist: [origin],
      judge: judge(),
      gen: new FakeGenerationGateway(),
      outDir,
      bounds: { maxDecisions: 4 },
      ...(actionDeltas ? { actionDeltas: true } : {}),
    });
    const persisted = JSON.parse(await readFile(result.transcriptPath, "utf8")) as Array<{ delta?: unknown }>;
    return { result, persisted };
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
}

describe("--action-deltas through the goal runner (#303)", () => {
  it("ON: deltas in the result, the transcript file, the Recording and the human output", async () => {
    const { result, persisted } = await run(true);
    const step = result.transcript.find((e) => e.delta !== undefined);
    expect(step?.delta?.verdict).toBe("relevant-change");
    expect(persisted.some((e) => e.delta !== undefined)).toBe(true);
    expect(result.recording.pages.flatMap((p) => p.steps).some((s) => s.delta?.verdict === "relevant-change")).toBe(true);
    expect(result.actionDeltas?.relevantChange).toBe(1);
    expect(formatMissionHuman(result)).toMatch(/DELTA\s+step \d+ click Save: relevant-change/);
  }, 90_000);

  it("OFF (default): no delta anywhere and no actionDeltas field", async () => {
    const { result, persisted } = await run(false);
    expect(result.transcript.some((e) => e.delta !== undefined)).toBe(false);
    expect(persisted.some((e) => e.delta !== undefined)).toBe(false);
    expect("actionDeltas" in result).toBe(false);
    expect(formatMissionHuman(result)).not.toMatch(/DELTA/);
  }, 90_000);
});
