import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { RunEvidenceSchema, type RunEvidence } from "@jevitate/adjudicator";
import { ALLOWED_TOOLS } from "@jevitate/mcp-facade";
import { FsJourneyStore, type Journey } from "@jevitate/journey";
import { PlaywrightBrowserPort, type BrowserPort } from "@jevitate/playwright";
import type { RecordedStep } from "@jevitate/recording";
import { buildMcpTools, type McpTool } from "./mcp-api.js";
import { journeyReviewHash } from "./journey-review.js";
import { EVIDENCE_FILE } from "./journey-run-evidence.js";
import { useSkippingTime } from "../../explore/src/testkit.js";

/**
 * 0.30.0 §5.1, served (real MCP tool, real Chromium): "Destructive control, off-allowlist write — test
 * mode: allowed within the declared environment; the record shows it — automation: refused unless mcpRun
 * lifts it, as 0.29.0". The test environment `stg` (trust "test") declares the app and its `api` origin; a
 * third origin nobody declares stays refused in test mode, a Journey's own `allowedOrigins` included, and
 * production refuses in every mode.
 */

useSkippingTime({ per: "all", pageClock: false });

let app: Server;
let api: Server;
let other: Server;
let appOrigin: string;
let apiOrigin: string;
let otherOrigin: string;
let root: string;
let journeysDir: string;
let logs: string;
const hits = { delete: 0, api: 0, other: 0 };
const launches = { count: 0 };

const page = (body: string): string => `<!doctype html><meta charset=utf-8><title>t</title>${body}`;
function send(res: ServerResponse, body: string): void {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(page(body));
}

function listen(handler: Parameters<typeof createServer>[1]): Promise<{ server: Server; origin: string }> {
  const server = createServer(handler);
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r({ server, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}` })));
}

function countingPort(): BrowserPort {
  launches.count += 1;
  return new PlaywrightBrowserPort();
}

const click = (testId: string, expectId: string): RecordedStep => ({ step: { kind: "click", target: { testId }, expect: { kind: "visible", target: { testId: expectId } } } }) as RecordedStep;

/** A Journey on the app, approved at a terminal (so automation mode may run it too). */
async function seed(id: string, steps: RecordedStep[], allowedOrigins?: string[]): Promise<void> {
  const j = {
    metadata: { id, name: id, promoted: true, params: [], parameters: [], ...(allowedOrigins === undefined ? {} : { allowedOrigins }), createdAtIso: "2026-11-08T00:00:00.000Z" },
    recording: { version: "1", site: appOrigin, pages: [{ url: "/", steps: [{ step: { kind: "navigate", url: "/", expect: { kind: "visible", target: { testId: "ready" } } } }, ...steps] }] },
  } as unknown as Journey;
  const store = new FsJourneyStore(journeysDir);
  await store.put(j);
  const stored = (await store.get(id))!;
  await store.put({ ...stored, metadata: { ...stored.metadata, approval: { contentHash: journeyReviewHash(stored), at: "2026-11-08T00:00:00.000Z", provenance: { channel: "tty", agentSignals: [] } } } } as Journey);
}

function tools(): Map<string, McpTool> {
  return new Map(
    buildMcpTools({
      journeysDir,
      pathRoots: [root],
      runRecordLogsRoot: logs,
      environmentsFile: join(root, "environments.json"),
      targetsConfigPath: join(root, "targets.json"),
      sitePolicyDbPath: join(root, "site.sqlite"),
      browserPortFactory: countingPort,
    }).map((t) => [t.name, t]),
  );
}

async function run(args: Record<string, unknown>): Promise<{ isError: boolean; text: string; body: Record<string, unknown> }> {
  const r = await tools().get("run_journey")!.handler(args);
  const text = r.content[0]!.text;
  return { isError: r.isError === true, text, body: JSON.parse(text) as Record<string, unknown> };
}

function allFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? allFiles(p) : [p];
  });
}

function evidence(): RunEvidence[] {
  return allFiles(logs)
    .filter((f) => f.endsWith(`/${EVIDENCE_FILE}`))
    .map((f) => RunEvidenceSchema.parse(JSON.parse(readFileSync(f, "utf8"))));
}

const targets = (t: object): void => writeFileSync(join(root, "targets.json"), JSON.stringify(t));

beforeAll(async () => {
  ({ server: api, origin: apiOrigin } = await listen((req, res) => {
    if (req.method === "POST") hits.api += 1;
    send(res, "<h1 data-testid=done>api</h1>");
  }));
  ({ server: other, origin: otherOrigin } = await listen((req, res) => {
    if (req.method === "POST") hits.other += 1;
    send(res, "<h1 data-testid=done>other</h1>");
  }));
  ({ server: app, origin: appOrigin } = await listen((req, res) => {
    if (req.method === "POST" && req.url === "/delete") {
      hits.delete += 1;
      send(res, "<p data-testid=gone>deleted</p>");
      return;
    }
    send(
      res,
      `<i data-testid=ready>ready</i>
      <form method=post action=/delete><button data-testid=del>Delete account</button></form>
      <form method=post action="${apiOrigin}/save"><button data-testid=to-api>Export</button></form>
      <form method=post action="${otherOrigin}/ext"><button data-testid=to-other>Export</button></form>
      <form method=post action=/delete><button data-testid=logout>Log out</button></form>`,
    );
  }));
  root = mkdtempSync(join(tmpdir(), "jev-test-mode-relax-"));
  journeysDir = join(root, "journeys");
  logs = join(root, "logs");
  mkdirSync(journeysDir, { recursive: true });
  // A person's files: `stg` is a declared test environment with its api origin; nothing declares `otherOrigin`.
  writeFileSync(join(root, "environments.json"), JSON.stringify({ stg: { baseUrl: appOrigin, origins: { api: apiOrigin }, trust: "test" } }));
  await seed("delete", [click("del", "gone")]);
  await seed("to-api", [click("to-api", "done")]);
  await seed("to-other", [click("to-other", "done")]);
  // An agent can author allowedOrigins: in test mode they do not widen the write allowlist past the declared environment.
  await seed("to-other-authored", [click("to-other", "done")], [otherOrigin]);
  await seed("logout", [click("logout", "gone")]);
});

afterAll(async () => {
  vi.unstubAllEnvs();
  for (const s of [app, api, other]) {
    s.closeAllConnections();
    await new Promise<void>((r) => s.close(() => r()));
  }
  rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  vi.stubEnv("JEVITATE_RUN_RECORD", "");
  rmSync(logs, { recursive: true, force: true });
  targets({});
  hits.delete = 0;
  hits.api = 0;
  hits.other = 0;
  launches.count = 0;
});

describe("0.30.0 §5.1 test mode relaxes destructive controls and declared-environment writes over MCP (real Chromium)", { timeout: 180_000 }, () => {
  it("a test target lets a destructive click act, and the evidence records it by rule and step, never the control's name", async () => {
    const r = await run({ id: "delete", env: "stg" });
    expect(r.body["outcome"], r.text).toBe("ok");
    expect(hits.delete).toBe(1);
    const [record, ...rest] = evidence();
    expect(rest).toEqual([]);
    expect(record!.run).toMatchObject({ channel: "mcp", mode: "test", target: { trust: "test" } });
    expect(record!.notes).toContain("test mode allowed step 2's destructive control (rule builtin:destructive), which automation mode refuses");
    expect(JSON.stringify(record)).not.toContain("Delete account");
  });

  it("the same click on an automation target is refused as in 0.29.0, and nothing reaches the server", async () => {
    const r = await run({ id: "delete", baseUrl: appOrigin });
    expect(r.body).toMatchObject({ error: "refused", outcome: "refused", code: "E_RUN_REFUSED_DESTRUCTIVE", rule: "builtin:destructive", at: 2, retryable: false });
    expect(hits.delete).toBe(0);
    // mcpRun still lifts it there.
    targets({ [appOrigin]: { mcpRun: { allowDestructive: true } } });
    expect((await run({ id: "delete", baseUrl: appOrigin })).body["outcome"]).toBe("ok");
    expect(hits.delete).toBe(1);
  });

  it("a write to the declared environment's api origin reaches it in test mode; on an automation target it is refused", async () => {
    const ok = await run({ id: "to-api", env: "stg" });
    expect(ok.body["outcome"], ok.text).toBe("ok");
    expect(hits.api).toBe(1);
    const shapes = evidence()[0]!.writes.shapes;
    expect(shapes).toEqual(expect.arrayContaining([expect.objectContaining({ method: "POST", origin: apiOrigin })]));

    const refused = await run({ id: "to-api", baseUrl: appOrigin });
    expect(refused.body).toMatchObject({ error: "refused", code: "E_RUN_REFUSED_OFF_ALLOWLIST_WRITE", at: 2, retryable: false });
    expect(hits.api).toBe(1);
  });

  it("a write to an origin the environment does not declare is refused even in test mode, an authored allowedOrigins entry included", async () => {
    for (const id of ["to-other", "to-other-authored"]) {
      const r = await run({ id, env: "stg" });
      expect(r.body, r.text).toMatchObject({ error: "refused", code: "E_RUN_REFUSED_OFF_ALLOWLIST_WRITE", at: 2, retryable: false, setting: `targets.json["${appOrigin}"].mcpRun.allowOffAllowlistWrites` });
    }
    expect(hits.other).toBe(0);
  });

  it("a session-ending control still refuses in test mode: only the destructive rule loosens", async () => {
    const r = await run({ id: "logout", env: "stg" });
    expect(r.body).toMatchObject({ code: "E_RUN_REFUSED_DESTRUCTIVE", rule: "builtin:session-end" });
    expect(hits.delete).toBe(0);
  });

  it("production refuses in every mode: an operator's trust 'production' wins over the environment's 'test'", async () => {
    targets({ [appOrigin]: { trust: "production" } });
    const r = await run({ id: "delete", env: "stg" });
    expect(r.body).toMatchObject({ error: "refused", code: "E_RUN_REFUSED_PRODUCTION" });
    expect(launches.count).toBe(0);
    expect(hits.delete).toBe(0);
  });

  it("serves exactly ALLOWED_TOOLS: no tool was added", () => {
    expect([...tools().keys()].sort()).toEqual([...ALLOWED_TOOLS].sort());
  });
});
