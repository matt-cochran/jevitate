import { spawnSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { RunEvidenceSchema, type RunEvidence } from "@jevitate/adjudicator";
import type { Journey } from "@jevitate/journey";
import { PlaywrightBrowserPort } from "@jevitate/playwright";
import { runJourneyProgrammatically } from "./journey-api.js";
import { EVIDENCE_FILE } from "./journey-run-evidence.js";
import { registerRunHooks, resetRunHooksForTests } from "./journey-run-hooks.js";
import { withJourneyRunRecord, type JourneyRunRecord } from "./journey-run-record.js";
import { MissionFixtures } from "./mission-fixtures.js";
import { useSkippingTime } from "../../explore/src/testkit.js";

useSkippingTime({ per: "all", pageClock: false });

/**
 * #812/#800 served acceptance: a real run (a real `new PlaywrightBrowserPort()`) whose parameter, fixture
 * output and page text each hold a marker writes `evidence.json` in its own directory beside the #790
 * record, and no marker is anywhere in it. The record parses with `RunEvidenceSchema`, and the #790 record
 * derived from the same observations counts the same writes.
 */

const MARKER_P = "MARKER_P-note-4417";
const MARKER_F = "MARKER_F-order-9921";
const MARKER_T = "MARKER_T-page-text-551";

let server: Server;
let origin: string;
let root: string;
let journeysDir: string;
let logs: string;
let keyFile: string;

const orderPage = (order: string): string => `<!doctype html><html><body><main>
<h1>Order</h1><p data-testid=label>${MARKER_T}</p>
<input data-testid=note aria-label=Note>
<button data-testid=send type=button>Save</button>
<script>
document.querySelector("[data-testid=send]").addEventListener("click", async () => {
  const note = document.querySelector("[data-testid=note]").value;
  const label = document.querySelector("[data-testid=label]").textContent;
  await fetch("/api/orders/" + encodeURIComponent(${JSON.stringify(order)}) + "/notes/" + encodeURIComponent(note) + "/" + encodeURIComponent(label) + "?q=" + encodeURIComponent(note), { method: "POST", body: note + label });
  document.body.insertAdjacentHTML("beforeend", "<p data-testid=sent>" + label + "</p>");
});
</script></main></body></html>`;

function journey(): Journey {
  return {
    metadata: {
      id: "order-note",
      name: "order-note",
      promoted: true,
      params: [],
      parameters: [{ name: "order", description: "the order" }, { name: "note", description: "a note" }],
      createdAtIso: "2026-11-08T00:00:00.000Z",
    },
    recording: {
      version: "1",
      site: origin,
      pages: [
        {
          url: "/orders",
          steps: [
            { step: { kind: "navigate", url: "/orders/${order}", expect: { kind: "visible", target: { testId: "note" } } } },
            { step: { kind: "fill", target: { testId: "note" }, value: { var: "note" }, expect: { kind: "visible", target: { testId: "note" } } } },
            { step: { kind: "extract", target: { testId: "label" }, as: "label", expect: { kind: "visible", target: { testId: "label" } } } },
            { step: { kind: "click", target: { testId: "send" }, expect: { kind: "visible", target: { testId: "sent" } } } },
          ],
        },
      ],
    },
  } as unknown as Journey;
}

function evidenceFiles(): string[] {
  if (!existsSync(logs)) return [];
  return readdirSync(logs).flatMap((date) =>
    readdirSync(join(logs, date))
      .filter((f) => f.startsWith("journey-evidence-") && statSync(join(logs, date, f)).isDirectory())
      .map((f) => join(logs, date, f, EVIDENCE_FILE)),
  );
}

function runRecords(): JourneyRunRecord[] {
  return readdirSync(logs).flatMap((date) =>
    readdirSync(join(logs, date))
      .filter((f) => f.startsWith("journey-run-") && f.endsWith(".json"))
      .map((f) => JSON.parse(readFileSync(join(logs, date, f), "utf8")) as JourneyRunRecord),
  );
}

const run = (params: Record<string, string>) =>
  withJourneyRunRecord({ channel: "mcp", id: "order-note", params, logsRoot: logs, evidenceKeyFile: keyFile }, (runRecorder) =>
    runJourneyProgrammatically({
      dir: journeysDir,
      id: "order-note",
      params,
      runRecorder,
      browserPortFactory: () => new PlaywrightBrowserPort(),
      fixtures: () => new MissionFixtures({ spec: { setup: [{ method: "POST", url: `${origin}/mint`, outputs: { orderId: "$.id" } }] }, auth: {}, allowlist: [origin], baseUrl: origin } as never),
    }),
  );

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = req.url ?? "/";
    if (req.method === "POST" && url === "/mint") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: MARKER_F }));
      return;
    }
    if (req.method === "POST") {
      req.resume();
      res.writeHead(201, { "content-type": "text/plain" });
      res.end(MARKER_T);
      return;
    }
    const order = /^\/orders\/([^/?]+)/.exec(url)?.[1];
    res.writeHead(200, { "content-type": "text/html" });
    res.end(order === undefined ? "<p>none</p>" : orderPage(decodeURIComponent(order)));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  root = mkdtempSync(join(tmpdir(), "jev-evidence-served-"));
  journeysDir = join(root, "journeys");
  mkdirSync(journeysDir, { recursive: true });
  writeFileSync(join(journeysDir, "order-note.json"), JSON.stringify(journey()));
  logs = join(root, "logs");
  // Injected: a test never writes to ~/.jevitate.
  keyFile = join(root, "home", "verify-checkpoint.key");
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  vi.stubEnv("JEVITATE_RUN_RECORD", "");
  rmSync(logs, { recursive: true, force: true });
});

afterEach(() => {
  vi.unstubAllEnvs();
  resetRunHooksForTests();
});

describe("#812 a served run's evidence.json", () => {
  it("is written in the run's own directory, parses, and holds no parameter value, fixture output or page text", async () => {
    const seen: string[] = [];
    registerRunHooks("served-test", {
      beforeWrite: (a) => void seen.push(`beforeWrite:${a.step}:${a.kind}`),
      readDoneCheck: async ({ page, result }) => void seen.push(`readDoneCheck:${result.outcome}:${(await page.textContent("[data-testid=sent]")) === MARKER_T}`),
    });
    const result = await run({ order: "${setup.orderId}", note: MARKER_P });
    expect(result.outcome, JSON.stringify(result)).toBe("ok");
    expect(result).not.toHaveProperty("evidenceError");
    expect(result).not.toHaveProperty("runRecordError");
    expect(seen).toEqual(["beforeWrite:4:click", "readDoneCheck:ok:true"]);

    const files = evidenceFiles();
    expect(files).toHaveLength(1);
    const file = files[0]!;
    const text = readFileSync(file, "utf8");
    // The acceptance check, as stated: `grep -c MARKER_` on the file is 0.
    const grep = spawnSync("grep", ["-c", "MARKER_", file], { encoding: "utf8" });
    expect(grep.stdout.trim()).toBe("0");
    expect(text.toLowerCase()).not.toContain("marker");
    expect(statSync(file).mode & 0o777).toBe(0o600);

    const evidence: RunEvidence = RunEvidenceSchema.parse(JSON.parse(text));
    expect(evidence.subject).toMatchObject({ kind: "journey-run", journey: { id: "order-note" } });
    expect(evidence.run).toMatchObject({ channel: "mcp", target: { origin }, secretParamNames: [] });
    expect(evidence.steps.map((s) => [s.index, s.kind, s.outcome])).toEqual([
      [1, "navigate", "ok"],
      [2, "fill", "ok"],
      [3, "extract", "ok"],
      [4, "click", "ok"],
    ]);
    expect(evidence.writes.sent).toEqual({ known: true, value: 1 });
    expect(evidence.writes.openAtClose).toEqual({ known: true, value: 0 });
    expect(evidence.writes.shapes).toEqual([{ step: 4, method: "POST", path: "/:id/orders/:param/:id/:param/:param", count: 1, status: { known: true, value: "2xx" } }]);

    // The #790 record beside it shares the run's key, and is derived from the same observations.
    const [record, ...more] = runRecords();
    expect(more).toEqual([]);
    expect(file).toContain(`journey-evidence-${/journey-run-(.+)\.json$/.exec(readdirSync(join(logs, readdirSync(logs)[0]!)).find((f) => f.startsWith("journey-run-"))!)![1]}`);
    expect(record!.writes).toMatchObject({ count: 1, refused: 0 });
    expect(JSON.stringify(record).toLowerCase()).not.toContain("marker");
  }, 90_000);

  it("a run a hook refuses still writes its evidence, and the refusal keeps its code", async () => {
    registerRunHooks("served-test", {
      validateParams: () => {
        throw new Error(`refused ${MARKER_P}`);
      },
    });
    await expect(run({ order: "${setup.orderId}", note: MARKER_P })).rejects.toMatchObject({ code: "E_RUN_HOOK" });
    const [file] = evidenceFiles();
    const evidence = RunEvidenceSchema.parse(JSON.parse(readFileSync(file!, "utf8")));
    expect(evidence.notes).toContain("the run ended with E_RUN_HOOK");
    expect(evidence.steps.every((s) => s.outcome === "not-reached")).toBe(true);
    expect(evidence.writes.sent).toEqual({ known: false, reason: "page-not-watched" });
    expect(readFileSync(file!, "utf8")).not.toContain("MARKER_");
  }, 60_000);

  it("evidence that cannot be written never changes the outcome: reported as evidenceError", async () => {
    mkdirSync(join(root, "home"), { recursive: true });
    writeFileSync(keyFile, "not a key");
    try {
      const result = await run({ order: "${setup.orderId}", note: MARKER_P });
      expect(result.outcome).toBe("ok");
      expect(String((result as { evidenceError?: string }).evidenceError)).toContain("the evidence record was not written");
      expect(evidenceFiles()).toEqual([]);
      expect(runRecords()).toHaveLength(1);
    } finally {
      rmSync(keyFile, { force: true });
    }
  }, 90_000);
});
