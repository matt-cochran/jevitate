import { createServer, type Server } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { adjudicate, RunEvidenceSchema, type RunEvidence } from "@jevitate/adjudicator";
import type { Journey } from "@jevitate/journey";
import { PlaywrightBrowserPort } from "@jevitate/playwright";
import type { SentinelGateway } from "@jevitate/runtime";
import { runJourneyProgrammatically } from "./journey-api.js";
import { EVIDENCE_FILE } from "./journey-run-evidence.js";
import { resetRunHooksForTests } from "./journey-run-hooks.js";
import { registerRunModeHooks } from "./journey-run-mode-gate.js";
import { withJourneyRunRecord } from "./journey-run-record.js";
import { registerSentinelShadowHook } from "./sentinel-hook.js";
import { useSkippingTime } from "../../explore/src/testkit.js";

useSkippingTime({ per: "all", pageClock: false });

/** #794 served acceptance: the shadow sentinel judges each write of an automation run, advisory only, structure only. */

const MARKER_T = "MARKER_T-page-text-794";

let server: Server;
let origin: string;
let root: string;
let journeysDir: string;
let logs: string;
let keyFile: string;
let targetsFile: string;
let payloads: string[];

const gateway: SentinelGateway = {
  async systemOne(args) {
    payloads.push(JSON.stringify(args));
    return { "write.destructive": { kind: "noul", probability: 0.9 }, "write.outside-intent": { kind: "noul", probability: 0.1 } };
  },
};

const page = `<!doctype html><html><body><main><h1>${MARKER_T}</h1><p>${MARKER_T}</p>
<button data-testid=one type=button>Save one</button><button data-testid=two type=button>Save two</button>
<script>
for (const id of ["one", "two"]) document.querySelector("[data-testid=" + id + "]").addEventListener("click", () => fetch("/api/save/" + id, { method: "POST", body: "x" }).then(() => document.body.insertAdjacentHTML("beforeend", "<i data-testid=done" + id + ">ok</i>")));
</script></main></body></html>`;

function journey(): Journey {
  const vis = (testId: string) => ({ kind: "visible", target: { testId } });
  return {
    metadata: { id: "two-writes", name: "two-writes", promoted: true, params: [], parameters: [], job: "save-things", createdAtIso: "2026-11-08T00:00:00.000Z" },
    recording: {
      version: "1",
      site: origin,
      pages: [
        {
          url: "/",
          steps: [
            { step: { kind: "navigate", url: "/", expect: vis("one") } },
            { step: { kind: "click", target: { role: "button", name: "Save one", testId: "one" }, expect: vis("doneone") } },
            { step: { kind: "click", target: { role: "button", name: "Save two", testId: "two" }, expect: vis("donetwo") } },
          ],
        },
      ],
    },
  } as unknown as Journey;
}

const evidenceFiles = (): string[] =>
  !existsSync(logs)
    ? []
    : readdirSync(logs).flatMap((d) =>
        readdirSync(join(logs, d))
          .filter((f) => f.startsWith("journey-evidence-") && statSync(join(logs, d, f)).isDirectory())
          .map((f) => join(logs, d, f, EVIDENCE_FILE)),
      );

const run = () =>
  withJourneyRunRecord({ channel: "cli", id: "two-writes", params: {}, logsRoot: logs, evidenceKeyFile: keyFile }, (runRecorder) =>
    runJourneyProgrammatically({ dir: journeysDir, id: "two-writes", params: {}, runRecorder, runGuardTargetsFile: targetsFile, browserPortFactory: () => new PlaywrightBrowserPort() }),
  );

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.method === "POST") {
      req.resume();
      res.writeHead(201, { "content-type": "text/plain" });
      res.end("ok");
      return;
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end(page);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  root = mkdtempSync(join(tmpdir(), "jev-sentinel-served-"));
  journeysDir = join(root, "journeys");
  mkdirSync(journeysDir, { recursive: true });
  writeFileSync(join(journeysDir, "two-writes.json"), JSON.stringify(journey()));
  logs = join(root, "logs");
  keyFile = join(root, "home", "verify-checkpoint.key");
  targetsFile = join(root, "targets.json");
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  vi.stubEnv("JEVITATE_RUN_RECORD", "");
  rmSync(logs, { recursive: true, force: true });
  payloads = [];
  resetRunHooksForTests();
  registerRunModeHooks();
});

afterEach(() => {
  vi.unstubAllEnvs();
  resetRunHooksForTests();
});

describe("#794 the shadow write sentinel, served", () => {
  it("an automation run with two writes carries two advisory judgments that change no verdict, with no page text sent", async () => {
    writeFileSync(targetsFile, JSON.stringify({}));
    const shadow = registerSentinelShadowHook({ gateway, jobTitle: () => "save the things" });
    const result = await run();
    expect(result.outcome, JSON.stringify(result)).toBe("ok");
    const [file, ...more] = evidenceFiles();
    expect(more).toEqual([]);
    const evidence: RunEvidence = RunEvidenceSchema.parse(JSON.parse(readFileSync(file!, "utf8")));
    expect(evidence.run.mode).toBe("automation");
    expect(evidence.judgments.map((j) => [j.step, j.task, j.advisory])).toEqual([
      [2, "write.destructive", true],
      [2, "write.outside-intent", true],
      [3, "write.destructive", true],
      [3, "write.outside-intent", true],
    ]);
    expect(evidence.judgments.filter((j) => j.task === "write.destructive")).toHaveLength(2);
    expect(adjudicate(evidence)).toEqual(adjudicate({ ...evidence, judgments: [] }));
    // Never a hold: both writes were sent, and the run finished.
    expect(evidence.writes.sent).toEqual({ known: true, value: 2 });
    expect(shadow.result).toEqual({ wouldHaveHeld: 2, judged: 2 });

    // Structure only: the page holds MARKER text, the hook never read it.
    expect(payloads).toHaveLength(2);
    for (const p of payloads) {
      expect(p).not.toContain("MARKER");
      expect(p).toContain("save-things");
      expect(p).toContain("save the things");
      expect(p).toMatch(/button \\"Save (one|two)\\"/);
    }
  }, 90_000);

  it("the same Journey on a test target has no judgments and the gateway got no call", async () => {
    writeFileSync(targetsFile, JSON.stringify({ [origin]: { trust: "test" } }));
    const shadow = registerSentinelShadowHook({ gateway });
    const result = await run();
    expect(result.outcome, JSON.stringify(result)).toBe("ok");
    const evidence = RunEvidenceSchema.parse(JSON.parse(readFileSync(evidenceFiles()[0]!, "utf8")));
    expect(evidence.run.mode).toBe("test");
    expect(evidence.judgments).toEqual([]);
    expect(payloads).toHaveLength(0);
    expect(shadow.result).toEqual({ wouldHaveHeld: 0, judged: 0 });
  }, 90_000);

  it("Jev unavailable: no judgments, a note, the run continues", async () => {
    writeFileSync(targetsFile, JSON.stringify({}));
    registerSentinelShadowHook({ gateway: { systemOne: () => Promise.reject(new Error("down")) } });
    const result = await run();
    expect(result.outcome).toBe("ok");
    const evidence = RunEvidenceSchema.parse(JSON.parse(readFileSync(evidenceFiles()[0]!, "utf8")));
    expect(evidence.judgments).toEqual([]);
    expect(evidence.notes.filter((n) => n.includes("jev-unavailable"))).toHaveLength(2);
  }, 90_000);
});
