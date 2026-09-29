import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FsJourneyStore, type Journey } from "@jevitate/journey";
import { buildMcpTools, type McpApiDeps, type McpTool, type McpVerifyFixArgs } from "./mcp-api.js";
import type { VerifyFixReport } from "./verify-fix-api.js";

/**
 * #255 served acceptance: MCP `run_journey` and `verify_fix` take the CLI's run options
 * (`journey run` / `verify-fix` flags) — validated as strictly as the CLI, paths confined, every
 * refusal typed. run_journey runs real Chromium against local servers: `baseUrl` moves the
 * recorded Journey onto another origin, `storageState` authenticates it, `viewport` emulates, and
 * `recordVideo`/`screenshots` come back as files on disk.
 */

const PAGE = (who: string, width: string): string =>
  `<!doctype html><html><body><h1>Home</h1><p id="who">${who}</p><p id="w">${width}</p><script>document.getElementById('w').textContent=String(innerWidth)</script><a href="/next">Next</a></body></html>`;

let recorded: Server;
let other: Server;
let recordedOrigin: string;
let otherOrigin: string;
let root: string;
const hits: Array<{ server: string; cookie: string }> = [];

async function listen(name: string): Promise<[Server, string]> {
  const server = createServer((req, res) => {
    hits.push({ server: name, cookie: req.headers.cookie ?? "" });
    const path = (req.url ?? "").split("?")[0] ?? "";
    const who = /who=([^;]+)/.exec(req.headers.cookie ?? "")?.[1] ?? "anonymous";
    if (path === "/home") return void res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(PAGE(who, "?"));
    if (path === "/next") return void res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end("<!doctype html><h1>Next</h1>");
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return [server, `http://127.0.0.1:${(server.address() as AddressInfo).port}`];
}

beforeAll(async () => {
  [recorded, recordedOrigin] = await listen("recorded");
  [other, otherOrigin] = await listen("other");
  root = await mkdtemp(join(tmpdir(), "jev-255-parity-"));
  const journey: Journey = {
    metadata: { id: "home", name: "Open home", promoted: true, params: [], createdAtIso: "2026-09-29T00:00:00.000Z" },
    recording: {
      version: "1",
      site: recordedOrigin,
      pages: [
        {
          url: "/home",
          steps: [
            { step: { kind: "navigate", url: "/home", expect: { kind: "visible", target: { role: "heading", name: "Home" } } }, objective: "Open home" },
            { step: { kind: "click", target: { role: "link", name: "Next" }, expect: { kind: "visible", target: { role: "heading", name: "Next" } } } },
          ],
        },
      ],
    },
  };
  await new FsJourneyStore(join(root, "journeys")).put(journey);
});

afterAll(async () => {
  await Promise.all([recorded, other].map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
  await rm(root, { recursive: true, force: true });
});

const deps = (over: Partial<McpApiDeps> = {}): McpApiDeps => ({ journeysDir: join(root, "journeys"), pathRoots: [root], ...over });
const tool = (d: McpApiDeps, name: string): McpTool => buildMcpTools(d).find((t) => t.name === name)!;
const body = (r: { content: Array<{ text: string }> }): Record<string, unknown> => JSON.parse(r.content[0]!.text) as Record<string, unknown>;

describe("#255 run_journey — journey run's options over MCP", () => {
  it("baseUrl + storageState + viewport + recordVideo + screenshots: served on the other origin, authenticated, media on disk", async () => {
    const state = join(root, "session.json");
    const host = new URL(otherOrigin).hostname;
    writeFileSync(state, JSON.stringify({ cookies: [{ name: "who", value: "alice", domain: host, path: "/", expires: -1, httpOnly: false, secure: false, sameSite: "Lax" }], origins: [] }));
    const videos = join(root, "videos");
    const shots = join(root, "shots");
    hits.length = 0;
    const res = await tool(deps(), "run_journey").handler({
      id: "home",
      baseUrl: otherOrigin,
      storageState: state,
      viewport: { width: 400, height: 700 },
      recordVideo: videos,
      screenshots: `steps:${shots}`,
    });
    const b = body(res);
    expect(res.isError, JSON.stringify(b)).toBeUndefined();
    expect(b.outcome).toBe("ok");
    // Moved onto the other origin (never the recorded one), with the session's cookie.
    expect(hits.filter((h) => h.server === "recorded")).toEqual([]);
    expect(hits.some((h) => h.server === "other" && h.cookie.includes("who=alice"))).toBe(true);
    const videoPaths = b.videoPaths as string[];
    const screenshotPaths = b.screenshotPaths as string[];
    expect(videoPaths.length).toBeGreaterThan(0);
    expect(screenshotPaths).toHaveLength(2);
    for (const f of [...videoPaths, ...screenshotPaths]) expect(existsSync(f), f).toBe(true);
    expect(videoPaths.every((f) => f.startsWith(videos))).toBe(true);
    expect(screenshotPaths.every((f) => f.startsWith(shots))).toBe(true);
  }, 120_000);

  it("refuses unusable options with a typed invalid_args — before any browser opens", async () => {
    const t = tool(deps(), "run_journey");
    const repoState = join(root, "repo", ".jevitate", "state.json");
    mkdirSync(join(root, "repo", ".jevitate"), { recursive: true });
    writeFileSync(repoState, "{}");
    hits.length = 0;
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ storageState: "/etc/passwd" }, /resolves outside/],
      [{ storageState: join(root, "..", "x.json") }, /resolves outside/],
      [{ storageState: repoState }, /never holds storage states/],
      [{ fixtures: "/etc/hosts" }, /resolves outside/],
      [{ recordVideo: "/tmp" }, /resolves outside/],
      [{ screenshots: "steps:/var/tmp" }, /resolves outside/],
      [{ viewport: { width: 375, height: 812 }, device: "iPhone 13" }, /mutually exclusive/],
      [{ viewport: { width: "375", height: 812 } }, /positive integers/],
      [{ device: "Nokia 3310 (not a device)" }, /device/i],
      [{ headed: "yes" }, /boolean/],
      [{ slowMo: -1 }, /integer/],
      [{ selfHeal: "sometimes" }, /fail-closed \| hybrid \| full/],
      [{ params: { n: 3 } }, /string values/],
      [{ env: "no-such-env" }, /.+/],
    ];
    for (const [args, message] of cases) {
      const res = await t.handler({ id: "home", ...args });
      const b = body(res);
      expect(res.isError, JSON.stringify(args)).toBe(true);
      expect(b.error, JSON.stringify(args)).toBe("invalid_args");
      expect(String(b.message), JSON.stringify(args)).toMatch(message);
    }
    expect(hits).toEqual([]);
  });

  it("selfHeal hybrid needs the model gateways: setup_required without them; with them the healer is wired", async () => {
    const without = await tool(deps(), "run_journey").handler({ id: "home", selfHeal: "hybrid", fakeAi: true });
    expect(body(without)).toMatchObject({ error: "setup_required" });
    const seen: Array<{ real: boolean; fakeAi: boolean }> = [];
    let options: unknown;
    const withGateways = tool(
      deps({
        selfHealGateways: async (sel) => {
          seen.push(sel);
          const { FakeGenerationGateway, FakeJudgmentGateway, UsageTracker } = await import("@jevitate/ai-core");
          return { judge: new FakeJudgmentGateway({}), gen: new FakeGenerationGateway(), usage: new UsageTracker() };
        },
        runJourney: async (_id, _params, _state, o) => {
          options = o;
          return { outcome: "ok" };
        },
      }),
      "run_journey",
    );
    const res = await withGateways.handler({ id: "home", selfHeal: "full", fakeAi: true });
    expect(res.isError).toBeUndefined();
    expect(seen).toEqual([{ real: false, fakeAi: true }]);
    expect(options).toMatchObject({ policy: { selfHeal: { mode: "full" } }, selfHealer: expect.anything() });
    expect(body(res)).toHaveProperty("usage");
  });

  it("an unknown Journey is a typed not_found (never a tool crash)", async () => {
    const res = await tool(deps(), "run_journey").handler({ id: "nope" });
    expect(res.isError).toBe(true);
    expect(body(res)).toMatchObject({ error: "not_found", id: "nope" });
  });
});

describe("#255 verify_fix — verify-fix's options over MCP", () => {
  const STEM = "explore-2026-09-29T00-00-00-000Z";
  const FP = "0123456789abcdef";
  const report: VerifyFixReport = { verdict: "fixed", exitCode: 0, replays: 3, fingerprint: FP } as unknown as VerifyFixReport;

  it("threads replays, recordVideo, screenshots, storageState, emulation, invariants and fixtures to the runner", async () => {
    const results = join(root, "results");
    mkdirSync(results, { recursive: true });
    writeFileSync(join(results, `${STEM}.result.json`), "{}");
    const state = join(root, "vf-state.json");
    writeFileSync(state, "{}");
    const inv = join(root, "inv.json");
    writeFileSync(inv, "{}");
    const fx = join(root, "fx.json");
    writeFileSync(fx, "{}");
    const calls: McpVerifyFixArgs[] = [];
    const t = tool(deps({ recordingsDir: results, verifyFix: async (a) => (calls.push(a), report) }), "verify_fix");
    const res = await t.handler({
      id: STEM,
      fingerprint: FP,
      replays: 5,
      recordVideo: true,
      screenshots: "steps",
      storageState: state,
      device: "iPhone 13",
      allowEmulationOverride: true,
      invariants: [inv],
      fixtures: fx,
    });
    expect(res.isError).toBeUndefined();
    expect(body(res)).toMatchObject({ id: STEM, status: "fixed" });
    expect(calls).toEqual([
      {
        resultPath: join(results, `${STEM}.result.json`),
        fingerprint: FP,
        replays: 5,
        browser: { recordVideo: {} },
        screenshots: { mode: "steps" },
        storageState: state,
        emulation: { device: "iPhone 13" },
        allowEmulationOverride: true,
        invariantFiles: [inv],
        fixtureFlags: { fixtures: fx },
      },
    ]);
  });

  it("refuses unusable options (typed invalid_args) before the runner is called", async () => {
    let called = 0;
    const t = tool(deps({ recordingsDir: join(root, "results"), verifyFix: async () => (called++, report) }), "verify_fix");
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ replays: 0 }, /integer >= 1/],
      [{ replays: 2.5 }, /integer >= 1/],
      [{ invariants: ["/etc/passwd"] }, /resolves outside/],
      [{ invariants: "inv.json" }, /array/],
      [{ storageState: join(root, "missing.json") }, /not found/],
      [{ viewport: { width: 375, height: 812 }, device: "iPhone 13" }, /mutually exclusive/],
      [{ recordVideo: "/tmp" }, /resolves outside/],
    ];
    for (const [args, message] of cases) {
      const res = await t.handler({ id: STEM, fingerprint: FP, ...args });
      expect(res.isError, JSON.stringify(args)).toBe(true);
      expect(body(res), JSON.stringify(args)).toMatchObject({ error: "invalid_args", message: expect.stringMatching(message) });
    }
    expect(called).toBe(0);
  });
});
