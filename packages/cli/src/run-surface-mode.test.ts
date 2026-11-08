import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Journey } from "@jevitate/journey";
import type { BrowserPort, BrowserSession } from "@jevitate/playwright";
import { runAsMcpInvocation } from "./approval-provenance.js";
import { resolveJourneyEnvironment } from "./environments.js";
import { E_APPROVAL_CHANNEL_FOR_MODE, E_HUMAN_STEP_IN_TEST_MODE, RunModeRefusedError } from "./journey-run-mode-gate.js";
import { McpRunGuard } from "./mcp-run-guard.js";
import { stampRunMetadata, withRunMetadata, currentRunMetadata } from "./run-metadata.js";
import { exploreDestructiveRefusal, guardedPortFactory, observeSurfaceRunModes, resolveSurfaceRunMode, runModeRecord } from "./run-surface-mode.js";

/**
 * 0.30.0 gap 4 (docs/design/0.30.0-evidence-and-trust.md §5): the run surfaces outside the run hooks (load,
 * exploration, the queued exploration's run, regression, verify-fix, source run) decide the mode from the
 * person-written files the run-mode hook reads, and apply what it means.
 */

const TEST_SITE = "https://test.example.test";
const PROD_SITE = "https://prod.example.test";
const OTHER = "https://other.example.test";

let dir: string;
let environmentsFile: string;
let targetsFile: string;

function journey(opts: { handback?: boolean; channel?: string } = {}): Journey {
  return {
    metadata: {
      id: "j1",
      name: "j1",
      promoted: true,
      params: [],
      createdAtIso: "2026-11-08T00:00:00.000Z",
      ...(opts.channel === undefined ? {} : { approval: { contentHash: "0".repeat(64), at: "2026-11-08T00:00:00.000Z", provenance: { channel: opts.channel, agentSignals: [] } } }),
    },
    recording: {
      version: "1.0.0",
      site: OTHER,
      pages: [
        {
          url: "/",
          steps: [
            { step: { kind: "navigate", url: "/", expect: { kind: "urlIncludes", text: "/" } } },
            ...(opts.handback === true ? [{ step: { kind: "handback", prompt: "Finish it", resume: { kind: "urlIncludes", text: "/done" } } }] : []),
          ],
        },
      ],
    },
  } as unknown as Journey;
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jev-surface-mode-"));
  environmentsFile = join(dir, "environments.json");
  targetsFile = join(dir, "targets.json");
  await writeFile(environmentsFile, JSON.stringify({ qa: { baseUrl: TEST_SITE, trust: "test" }, live: { baseUrl: PROD_SITE, production: true } }));
  await writeFile(targetsFile, "{}");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const files = () => ({ environmentsFile, targetsFile });

describe("resolveSurfaceRunMode", () => {
  it("decides the mode from the declared trust only, and tells observers", () => {
    const seen: string[] = [];
    const stop = observeSurfaceRunModes((d) => seen.push(`${d.surface}:${d.mode}:${d.trust}`));
    try {
      const qa = resolveJourneyEnvironment({ env: "qa", environmentsFile, targets: {} });
      expect(resolveSurfaceRunMode({ surface: "explore", origin: TEST_SITE, environment: qa, ...files() }).mode).toBe("test");
      // Not the environment's own origin: what the file vouches for does not reach it.
      expect(resolveSurfaceRunMode({ surface: "explore", origin: OTHER, environment: qa, ...files() }).mode).toBe("automation");
      // No environment named: an origin a production environment declares is production.
      expect(resolveSurfaceRunMode({ surface: "load", origin: PROD_SITE, ...files() }).trust).toBe("production");
      expect(resolveSurfaceRunMode({ surface: "regression", origin: OTHER, ...files() }).trust).toBe("unknown");
    } finally {
      stop();
    }
    expect(seen).toEqual(["explore:test:test", "explore:automation:unknown", "load:automation:production", "regression:automation:unknown"]);
  });

  it("a targets.json trust test puts the origin in test mode; a stricter declaration wins", async () => {
    await writeFile(targetsFile, JSON.stringify({ [OTHER]: { trust: "test" }, [PROD_SITE]: { trust: "test" } }));
    expect(resolveSurfaceRunMode({ surface: "mission", origin: OTHER, ...files() }).mode).toBe("test");
    expect(resolveSurfaceRunMode({ surface: "mission", origin: PROD_SITE, ...files() }).mode).toBe("automation");
  });

  it("over MCP an automation-mode Journey surface refuses an approval no person made", async () => {
    const run = (channel: string) => runAsMcpInvocation(async () => resolveSurfaceRunMode({ surface: "load", journey: journey({ channel }), origin: OTHER, ...files() }));
    await expect(run("mcp")).rejects.toMatchObject({ refusalCode: E_APPROVAL_CHANNEL_FOR_MODE, mode: "automation" });
    await expect(run("tty")).resolves.toMatchObject({ mode: "automation" });
    // On the CLI the person at the terminal is the guard: no approval-channel refusal.
    expect(resolveSurfaceRunMode({ surface: "load", journey: journey({ channel: "mcp" }), origin: OTHER, ...files() }).mode).toBe("automation");
  });

  it("a test-mode Journey surface accepts an MCP approval, and refuses a human step", async () => {
    const qa = resolveJourneyEnvironment({ env: "qa", environmentsFile, targets: {} });
    const run = (j: Journey) => runAsMcpInvocation(async () => resolveSurfaceRunMode({ surface: "load", journey: j, origin: TEST_SITE, environment: qa, ...files() }));
    await expect(run(journey({ channel: "mcp" }))).resolves.toMatchObject({ mode: "test", trust: "test" });
    const refused = await run(journey({ channel: "tty", handback: true })).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(RunModeRefusedError);
    expect(refused).toMatchObject({ refusalCode: E_HUMAN_STEP_IN_TEST_MODE });
  });

  it("records run.mode and run.target.trust, with test mode's notes", () => {
    const decided = resolveSurfaceRunMode({ surface: "verify-fix", origin: PROD_SITE, ...files() });
    expect(runModeRecord(decided)).toEqual({ mode: "automation", target: { origin: PROD_SITE, trust: "production" } });
    expect(runModeRecord(decided, ["n"])).toMatchObject({ notes: ["n"] });
  });
});

describe("exploreDestructiveRefusal", () => {
  it("over MCP: refused in automation mode unless mcpRun.allowDestructive; allowed and noted in test mode", async () => {
    const qa = resolveJourneyEnvironment({ env: "qa", environmentsFile, targets: {} });
    const automation = resolveSurfaceRunMode({ surface: "explore", origin: OTHER, ...files() });
    const test = resolveSurfaceRunMode({ surface: "explore", origin: TEST_SITE, environment: qa, ...files() });
    const notes: string[] = [];
    const refused = await runAsMcpInvocation(async () => exploreDestructiveRefusal(automation, true, notes));
    expect(refused?.code).toBe("E_RUN_REFUSED_DESTRUCTIVE");
    expect(refused?.setting).toBe(`targets.json["${OTHER}"].mcpRun.allowDestructive`);
    expect(await runAsMcpInvocation(async () => exploreDestructiveRefusal(automation, false, notes))).toBeUndefined();
    expect(await runAsMcpInvocation(async () => exploreDestructiveRefusal(test, true, notes))).toBeUndefined();
    expect(notes).toHaveLength(1);
    // Outside MCP the person decides.
    expect(exploreDestructiveRefusal(automation, true, [])).toBeUndefined();
    await writeFile(targetsFile, JSON.stringify({ [OTHER]: { mcpRun: { allowDestructive: true } } }));
    const lifted = resolveSurfaceRunMode({ surface: "explore", origin: OTHER, ...files() });
    expect(await runAsMcpInvocation(async () => exploreDestructiveRefusal(lifted, true, []))).toBeUndefined();
  });
});

describe("guardedPortFactory", () => {
  it("arms a fresh guard on every session the inner port opens", async () => {
    const opened: string[] = [];
    const inner = (): BrowserPort => ({ open: async () => ({ page: {}, close: async () => undefined }) as unknown as BrowserSession });
    let guards = 0;
    const factory = guardedPortFactory(inner, () => {
      guards += 1;
      const g = new McpRunGuard(OTHER, [OTHER], {}, undefined);
      const arm = g.arm.bind(g);
      g.arm = async (s, p) => {
        opened.push("armed");
        return arm(s, p);
      };
      return g;
    });
    await factory().open({} as never);
    await factory().open({} as never);
    expect(guards).toBe(2);
    expect(opened).toEqual(["armed", "armed"]);
  });

  it("outside MCP (no guard) the session is the inner one's", async () => {
    const session = { page: {}, close: async () => undefined } as unknown as BrowserSession;
    const factory = guardedPortFactory(() => ({ open: async () => session }), () => undefined);
    expect(await factory().open({} as never)).toBe(session);
  });
});

describe("run metadata: the decided mode is stamped on a written result", () => {
  it("adds run, read when the result is written; a result's own run is kept", () => {
    const notes: string[] = [];
    const record = () => ({ mode: "test" as const, target: { origin: TEST_SITE, trust: "test" as const }, ...(notes.length === 0 ? {} : { notes: [...notes] }) });
    withRunMetadata({ runMode: record }, () => {
      notes.push("relaxed");
      expect(stampRunMetadata({ outcome: "clean" })).toMatchObject({ run: { mode: "test", notes: ["relaxed"] } });
      expect(stampRunMetadata({ run: { mode: "automation" } })).toEqual({ run: { mode: "automation" } });
      // A nested scope (a multi-run child) keeps the outer mode unless it decides its own.
      withRunMetadata({ tags: { a: "b" } }, () => expect(currentRunMetadata()?.runMode).toBe(record));
    });
    expect(stampRunMetadata({ outcome: "clean" })).toEqual({ outcome: "clean" });
  });
});
