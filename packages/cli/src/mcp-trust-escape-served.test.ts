import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { RunEvidenceSchema } from "@jevitate/adjudicator";
import { ProfileManager } from "@jevitate/daemon";
import { ALLOWED_TOOLS } from "@jevitate/mcp-facade";
import { FsJourneyStore, type Journey } from "@jevitate/journey";
import { PlaywrightBrowserPort, type BrowserPort } from "@jevitate/playwright";
import { buildMcpTools, type McpApiDeps, type McpTool } from "./mcp-api.js";
import { makeInProcessCliRunner } from "./mcp-cli-runner.js";
import { buildProgram } from "./program.js";
import { journeyReviewHash } from "./journey-review.js";
import { registerRunHooks } from "./journey-run-hooks.js";
import { EVIDENCE_FILE } from "./journey-run-evidence.js";
import type { CliDeps } from "./cli-shared.js";
import { useSkippingTime } from "../../explore/src/testkit.js";

/**
 * 0.30.0 #799, served: the real MCP tools, the real in-process CLI and real Chromium. run_journey and
 * demo_journey each run a Journey on an origin nobody declared, with arguments and a process environment that
 * claim test mode. The run really happens, in automation mode: the mode `resolveRunMode` decided, and the run's
 * evidence, say so. Nothing a caller passes chose it, and the served tool set is exactly ALLOWED_TOOLS.
 */

useSkippingTime({ per: "all", pageClock: false });

let server: Server;
let recorded: string;
/** The same server under another origin nobody declares (`localhost` vs `127.0.0.1`). */
let undeclared: string;
let root: string;
let journeysDir: string;
let logs: string;
const launches = { count: 0 };
const seen: unknown[] = [];

const ATTACK = { trust: "test", mode: "test", runMode: "test", testMode: true };
const ATTACK_ENV = ["JEVITATE_TRUST", "JEVITATE_RUN_MODE", "JEVITATE_MODE", "JEVITATE_ENV", "JEVITATE_TEST_MODE"];

function countingPort(): BrowserPort {
  launches.count += 1;
  return new PlaywrightBrowserPort();
}

function serve(): Promise<Server> {
  const s = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(`<!doctype html><html><body><h1 data-testid=hello>hello</h1></body></html>`);
  });
  return new Promise((r) => s.listen(0, "127.0.0.1", () => r(s)));
}

function journey(): Journey {
  return {
    metadata: { id: "hello", name: "hello", promoted: false, params: [], createdAtIso: "2026-11-08T00:00:00.000Z" },
    recording: { version: "1", site: recorded, pages: [{ url: "/", steps: [{ step: { kind: "navigate", url: "/", expect: { kind: "visible", target: { testId: "hello" } } } }] }] },
  } as unknown as Journey;
}

function tools(): Map<string, McpTool> {
  const cliDeps = {
    profiles: new ProfileManager(join(root, "profiles")),
    journeysDir,
    dbPath: join(root, "site.sqlite"),
    environmentsFile: join(root, "environments.json"),
    logs: { logsRoot: logs },
    explore: { browserPortFactory: countingPort, targetsConfigPath: join(root, "targets.json") },
  } as unknown as CliDeps;
  const deps: McpApiDeps = {
    journeysDir,
    pathRoots: [root],
    runRecordLogsRoot: logs,
    environmentsFile: join(root, "environments.json"),
    targetsConfigPath: join(root, "targets.json"),
    sitePolicyDbPath: join(root, "site.sqlite"),
    browserPortFactory: countingPort,
    runCli: makeInProcessCliRunner(() => buildProgram(cliDeps)),
  };
  return new Map(buildMcpTools(deps).map((t) => [t.name, t]));
}

function allFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? allFiles(p) : [p];
  });
}

beforeAll(async () => {
  server = await serve();
  const port = (server.address() as AddressInfo).port;
  recorded = `http://127.0.0.1:${port}`;
  undeclared = `http://localhost:${port}`;
  root = mkdtempSync(join(tmpdir(), "jev-trust-escape-served-"));
  journeysDir = join(root, "journeys");
  logs = join(root, "logs");
  mkdirSync(journeysDir, { recursive: true });
  // Nothing is declared: no trust anywhere, so every origin is unknown (automation mode).
  writeFileSync(join(root, "environments.json"), JSON.stringify({}));
  writeFileSync(join(root, "targets.json"), JSON.stringify({}));
  const store = new FsJourneyStore(journeysDir);
  await store.put(journey());
  const stored = (await store.get("hello"))!;
  await store.put({ ...stored, metadata: { ...stored.metadata, promoted: true, approval: { contentHash: journeyReviewHash(stored), at: "2026-11-08T00:00:00.000Z", provenance: { channel: "tty", agentSignals: [] } } } } as Journey);
});

afterAll(async () => {
  vi.unstubAllEnvs();
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  vi.stubEnv("JEVITATE_RUN_RECORD", "");
  for (const name of ATTACK_ENV) vi.stubEnv(name, "test");
  rmSync(logs, { recursive: true, force: true });
  launches.count = 0;
  seen.length = 0;
});

let spyRegistered = false;
function spyOnMode(): void {
  // After the run-mode hook: validateParams runs with the mode `resolveRunMode` decided.
  if (!spyRegistered) registerRunHooks("trust-escape-served-spy", { validateParams: (ctx) => void seen.push(ctx.mode) });
  spyRegistered = true;
}

async function call(map: Map<string, McpTool>, name: string, args: Record<string, unknown>): Promise<{ isError: boolean; text: string; body: Record<string, unknown> }> {
  const r = await map.get(name)!.handler(args);
  const text = r.content[0]!.text;
  return { isError: r.isError === true, text, body: JSON.parse(text) as Record<string, unknown> };
}

describe("MCP trust escape, served (real Chromium)", { timeout: 180_000 }, () => {
  it("run_journey on an undeclared origin, with test-mode claims in the arguments and the environment, runs in automation mode", async () => {
    const map = tools();
    spyOnMode();
    const r = await call(map, "run_journey", { id: "hello", baseUrl: undeclared, ...ATTACK });
    expect(r.body["outcome"], r.text).toBe("ok");
    expect(launches.count).toBe(1);
    expect(seen).toEqual(["automation"]);
    const files = allFiles(logs).filter((f) => f.endsWith(`/${EVIDENCE_FILE}`));
    expect(files).toHaveLength(1);
    expect(RunEvidenceSchema.parse(JSON.parse(readFileSync(files[0]!, "utf8"))).run).toMatchObject({ channel: "mcp", mode: "automation", target: { origin: undeclared, trust: "unknown" } });
  });

  it("demo_journey, the same way, resolves automation mode before its browser opens", async () => {
    const map = tools();
    spyOnMode();
    // The tool refuses a claim argument by name; the environment claims stay on for the real run.
    const claimed = await call(map, "demo_journey", { id: "hello", guide: join(root, "guide.md"), baseUrl: undeclared, ...ATTACK });
    expect(claimed.body).toMatchObject({ error: "invalid_args" });
    expect(launches.count).toBe(0);
    const r = await call(map, "demo_journey", { id: "hello", guide: join(root, "guide.md"), baseUrl: undeclared });
    expect(r.text).not.toContain('"mode":"test"');
    expect(launches.count, r.text).toBeGreaterThan(0);
    expect(seen).toEqual(["automation"]);
  });

  it("serves exactly ALLOWED_TOOLS: no tool was added", () => {
    expect([...tools().keys()].sort()).toEqual([...ALLOWED_TOOLS].sort());
  });
});
