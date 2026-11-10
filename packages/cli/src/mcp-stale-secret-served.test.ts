import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ProfileManager } from "@jevitate/daemon";
import { ALLOWED_TOOLS } from "@jevitate/mcp-facade";
import { FsJourneyStore, type Journey } from "@jevitate/journey";
import { PlaywrightBrowserPort } from "@jevitate/playwright";
import { buildMcpTools, type McpApiDeps, type McpTool } from "./mcp-api.js";
import { makeInProcessCliRunner } from "./mcp-cli-runner.js";
import { buildProgram } from "./program.js";
import { journeyReviewHash } from "./journey-review.js";
import { journeyApprovalState } from "./journey-stale-api.js";
import type { CliDeps } from "./cli-shared.js";
import { SECRET_PARAM_OVER_MCP } from "./secret-params.js";
import { useSkippingTime } from "../../explore/src/testkit.js";

/**
 * Independent re-check H7, served (h1b-stale.mjs): the real MCP tools, the real in-process CLI and real
 * Chromium. A Journey a person approved at a terminal, then edited (its approval is stale), never gets
 * the operator's targets.json secret over MCP: run_journey refuses it, and so do verify_journey,
 * journey_readiness (replay), demo_journey and chain_journeys, on an automation-mode target and on a
 * test-mode one. Every value the page sees is logged; the marker never reaches the app.
 */

useSkippingTime({ per: "all", pageClock: false });

const MARKER = "MARKER_H7pw9Zq";
const VAR = "JEV_H7_SECRET";

let server: Server;
let origin: string;
let testOrigin: string;
let root: string;
let journeysDir: string;
let logs: string;
const seen: string[] = [];

function serve(): Promise<Server> {
  const s = createServer((req, res) => {
    seen.push(decodeURIComponent(req.url ?? ""));
    if ((req.url ?? "").startsWith("/got")) return void res.writeHead(204).end();
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(
      `<!doctype html><html><body><label>Password <input type=password oninput="fetch('/got?v='+encodeURIComponent(this.value))"></label>` +
        `<input data-testid=who aria-label=Who oninput="fetch('/got?w='+encodeURIComponent(this.value))">` +
        `<button type=button onclick="document.querySelector('[data-testid=st]').textContent='ok'">Go</button><p data-testid=st>-</p></body></html>`,
    );
  });
  return new Promise((r) => s.listen(0, "127.0.0.1", () => r(s)));
}

function journey(id: string): Journey {
  const vis = { kind: "visible", target: { testId: "who" } };
  return {
    metadata: { id, name: id, promoted: false, params: ["password", "who"], parameters: [{ name: "password", secret: true }, { name: "who" }], createdAtIso: "2026-11-09T00:00:00.000Z" },
    recording: {
      version: "1",
      site: origin,
      pages: [
        {
          url: "/",
          steps: [
            { step: { kind: "navigate", url: "/", expect: vis } },
            { step: { kind: "fill", target: { label: "Password" }, value: { var: "password" }, expect: vis } },
            { step: { kind: "fill", target: { testId: "who" }, value: { var: "who" }, expect: vis } },
            { step: { kind: "click", target: { role: "button", name: "Go" }, expect: { kind: "textIncludes", target: { testId: "st" }, text: "ok" } } },
          ],
        },
      ],
    },
  } as unknown as Journey;
}

/** Approved at a terminal, then edited: the secret is now also typed into the visible Who field. */
async function staleAfterTty(id: string): Promise<void> {
  const store = new FsJourneyStore(journeysDir);
  await store.put(journey(id));
  const j = (await store.get(id))!;
  await store.put({ ...j, metadata: { ...j.metadata, promoted: true, approval: { contentHash: journeyReviewHash(j), at: "2026-11-09T00:00:00.000Z", provenance: { channel: "tty", agentSignals: [] } } } } as Journey);
  const approved = (await store.get(id))!;
  const steps = approved.recording.pages[0]!.steps as unknown[];
  steps.splice(3, 0, { step: { kind: "fill", target: { testId: "who" }, value: { var: "password" }, expect: { kind: "visible", target: { testId: "who" } } } });
  await store.put(approved);
}

function tools(): Map<string, McpTool> {
  const port = () => new PlaywrightBrowserPort();
  const cliDeps = {
    profiles: new ProfileManager(join(root, "profiles")),
    journeysDir,
    catalogDir: join(root, ".jevitate"),
    dbPath: join(root, "site.sqlite"),
    environmentsFile: join(root, "environments.json"),
    logs: { logsRoot: logs },
    explore: { browserPortFactory: port, targetsConfigPath: join(root, "targets.json"), env: { ...process.env, [VAR]: MARKER } },
  } as unknown as CliDeps;
  const deps: McpApiDeps = {
    journeysDir,
    pathRoots: [root],
    runRecordLogsRoot: logs,
    environmentsFile: join(root, "environments.json"),
    targetsConfigPath: join(root, "targets.json"),
    sitePolicyDbPath: join(root, "site.sqlite"),
    browserPortFactory: port,
    secretEnv: { [VAR]: MARKER },
    runCli: makeInProcessCliRunner(() => buildProgram(cliDeps)),
  };
  return new Map(buildMcpTools(deps).map((t) => [t.name, t]));
}

async function call(name: string, args: Record<string, unknown>): Promise<{ isError: boolean; text: string; body: Record<string, unknown> }> {
  const r = await tools().get(name)!.handler(args);
  const text = r.content.map((c) => (c as { text?: string }).text ?? "").join("\n");
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(r.content[0]!.text) as Record<string, unknown>;
  } catch {
    // not JSON
  }
  return { isError: r.isError === true, text, body };
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
  origin = `http://127.0.0.1:${port}`;
  testOrigin = `http://localhost:${port}`;
  root = mkdtempSync(join(tmpdir(), "jev-h7-stale-"));
  journeysDir = join(root, "journeys");
  logs = join(root, "logs");
  mkdirSync(journeysDir, { recursive: true });
  mkdirSync(join(root, ".jevitate"), { recursive: true });
  writeFileSync(join(root, "environments.json"), JSON.stringify({ tst: { baseUrl: testOrigin, trust: "test" } }));
  writeFileSync(join(root, "targets.json"), JSON.stringify({ [origin]: { secretFields: [`label=Password=env:${VAR}`] }, [testOrigin]: { secretFields: [`label=Password=env:${VAR}`] } }));
  writeFileSync(join(root, "requests.jsonl"), "");
  await staleAfterTty("stalesec");
  await new FsJourneyStore(journeysDir).put(journey("reply"));
});

afterAll(async () => {
  vi.unstubAllEnvs();
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  vi.stubEnv("JEVITATE_RUN_RECORD", "");
});

const surfaces = (where: Record<string, unknown>): Array<readonly [string, Record<string, unknown>]> => [
  ["run_journey", { id: "stalesec", ...where, params: { who: "ann" } }],
  ["verify_journey", { id: "stalesec", mutate: true, ...where, params: { who: "ann" } }],
  ["journey_readiness", { id: "stalesec", mode: "replay", ...where, params: { who: "ann" } }],
  ["demo_journey", { id: "stalesec", guide: join(root, `demo-${Object.keys(where)[0]}.md`), ...where, params: { who: "ann" } }],
  ["chain_journeys", { from: "stalesec", to: "reply", requests: join(root, "requests.jsonl"), ...where, params: { who: "ann" } }],
];

describe("H7: a stale person approval never gets the operator's targets.json secret over MCP (real Chromium)", { timeout: 300_000 }, () => {
  it("the fixture's approval is stale", async () => {
    const j = (await new FsJourneyStore(journeysDir).get("stalesec"))!;
    expect((await journeyApprovalState(j, { journeysDir, catalogDir: null })).approval).toBe("stale");
  });

  for (const [label, where] of [
    ["automation-mode target", { baseUrl: "ORIGIN" }],
    ["test-mode target", { env: "tst" }],
  ] as const) {
    it(`${label}: every surface refuses E_SECRET_PARAM_OVER_MCP or holds, and the marker never reaches the app`, async () => {
      const args = where.baseUrl === undefined ? where : { baseUrl: origin };
      for (const [tool, a] of surfaces(args)) {
        const before = seen.length;
        const r = await call(tool, a);
        const reached = seen.slice(before).filter((u) => u.includes(MARKER));
        expect(reached, `${tool}: ${r.text.slice(0, 300)}`).toEqual([]);
        expect(r.text, tool).not.toContain(MARKER);
        const held = r.body["outcome"] === "held";
        // Stricter still is fine: chain_journeys refuses the stale Journey itself (#788), and journey_readiness checks its
        // required params before any browser, refusing the secret it was not given by name.
        const refused = [SECRET_PARAM_OVER_MCP, "E_JOURNEY_APPROVAL_STALE", ...(tool === "journey_readiness" ? ["E_READINESS_PARAMS"] : [])];
        if (!held) expect(refused, `${tool}: ${r.text.slice(0, 300)}`).toContain(r.body["code"]);
      }
    });
  }

  it("nothing at rest holds the marker, and exactly ALLOWED_TOOLS are served", () => {
    expect(allFiles(root).filter((f) => readFileSync(f).includes(MARKER))).toEqual([]);
    expect([...tools().keys()].sort()).toEqual([...ALLOWED_TOOLS].sort());
  });
});
