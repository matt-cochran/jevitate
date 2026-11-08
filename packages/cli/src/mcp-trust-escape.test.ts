import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ProfileManager } from "@jevitate/daemon";
import { FsJourneyStore, type Journey } from "@jevitate/journey";
import { buildMcpTools, type McpApiDeps, type McpTool } from "./mcp-api.js";
import { makeInProcessCliRunner } from "./mcp-cli-runner.js";
import { buildProgram } from "./program.js";
import { journeyReviewHash } from "./journey-review.js";
import { registerRunHooks } from "./journey-run-hooks.js";
import { resolveRunTarget } from "./journey-run-mode-gate.js";
import type { CliDeps } from "./cli-shared.js";

/**
 * 0.30.0 #799 (docs/design/0.30.0-evidence-and-trust.md §5): the MCP trust boundary. For every MCP tool that
 * starts a run, against a declared-production target, a declared target with no trust and a baseUrl nobody
 * declared, the mode the run resolves is 'automation', whatever the arguments claim (a `trust`, a `mode`, a
 * forged environment name) and whatever the process environment says. No browser opens: the port factory throws,
 * and the mode is read from a spy hook placed after the run-mode hook (the mode `resolveRunMode` decided) or from
 * the refusal body's own `mode`.
 *
 * FINDING cells: a tool that starts a run but never reaches `resolveRunMode` resolves no mode at all, so the cell
 * cannot assert 'automation'. They are `it.fails` (they pass while the mode is unresolved, and fail the day a mode
 * is wired, which is the cue to turn them into plain cells). run_load_test, run_exploration and queue_exploration
 * (and load-api, regression, verify-fix and source runs) are the findings; see the report.
 */

const UNDECLARED = "https://undeclared.example.test";
const PROD = "https://prod.example.test";
const DECLARED = "https://declared.example.test";

type TargetKind = "declared production" | "declared unknown" | "undeclared baseUrl";
const TARGETS: readonly TargetKind[] = ["declared production", "declared unknown", "undeclared baseUrl"];

/** What each target kind is, as arguments: a forged environment NAME ("test") holding a production target; a declared environment without trust; a bare baseUrl. */
const TARGET_ARGS: Readonly<Record<TargetKind, Record<string, string>>> = {
  "declared production": { env: "test" },
  "declared unknown": { env: "staging" },
  "undeclared baseUrl": { baseUrl: UNDECLARED },
};

/** Arguments that try to claim test mode. A tool that refuses an unknown argument by name is retried without them. */
const ATTACK_ARGS: Readonly<Record<string, unknown>> = { trust: "test", mode: "test", runMode: "test", testMode: true, environmentTrust: "test", targetTrust: "harness" };
const ATTACK_ENV = ["JEVITATE_TRUST", "JEVITATE_RUN_MODE", "JEVITATE_MODE", "JEVITATE_ENV", "JEVITATE_TEST_MODE", "JEVITATE_TARGET_TRUST"];

let root: string;
let journeysDir: string;
let tools: Map<string, McpTool>;
const launches = { count: 0 };
const seen: unknown[] = [];

function journey(): Journey {
  return {
    metadata: { id: "j1", name: "j1", promoted: false, params: [], createdAtIso: "2026-11-08T00:00:00.000Z" },
    recording: { version: "1", site: UNDECLARED, pages: [{ url: "/", steps: [{ step: { kind: "navigate", url: "/", expect: { kind: "urlIncludes", text: "/" } } }] }] },
  } as unknown as Journey;
}

function buildTools(): Map<string, McpTool> {
  const factory = (): never => {
    launches.count += 1;
    throw new Error("no browser in this test");
  };
  const cliDeps = {
    profiles: new ProfileManager(join(root, "profiles")),
    journeysDir,
    dbPath: join(root, "site.sqlite"),
    environmentsFile: join(root, "environments.json"),
    logs: { logsRoot: join(root, "logs") },
    explore: { browserPortFactory: factory, targetsConfigPath: join(root, "targets.json") },
  } as unknown as CliDeps;
  const deps: McpApiDeps = {
    journeysDir,
    pathRoots: [root],
    runRecordLogsRoot: join(root, "logs"),
    environmentsFile: join(root, "environments.json"),
    targetsConfigPath: join(root, "targets.json"),
    sitePolicyDbPath: join(root, "site.sqlite"),
    browserPortFactory: factory,
    runCli: makeInProcessCliRunner(() => buildProgram(cliDeps)),
  };
  return new Map(buildMcpTools(deps).map((t) => [t.name, t]));
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "jev-trust-escape-"));
  journeysDir = join(root, "journeys");
  mkdirSync(journeysDir, { recursive: true });
  // A person wrote both files. "test" is a forged NAME on a production target; "staging" is declared with no trust.
  writeFileSync(join(root, "environments.json"), JSON.stringify({ test: { baseUrl: PROD, production: true }, staging: { baseUrl: DECLARED } }));
  writeFileSync(join(root, "targets.json"), "{}");
  writeFileSync(join(root, "requests.jsonl"), "");
  const store = new FsJourneyStore(journeysDir);
  await store.put(journey());
  const stored = (await store.get("j1"))!;
  // Approved as a person at a terminal would: the approval is not what is under test, the mode is.
  await store.put({ ...stored, metadata: { ...stored.metadata, promoted: true, approval: { contentHash: journeyReviewHash(stored), at: "2026-11-08T00:00:00.000Z", provenance: { channel: "tty", agentSignals: [] } } } } as Journey);
  tools = buildTools();
  // After the run-mode hook: validateParams runs with the mode `resolveRunMode` decided.
  registerRunHooks("trust-escape-spy", { validateParams: (ctx) => void seen.push(ctx.mode) });
});

afterAll(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  seen.length = 0;
  launches.count = 0;
  for (const name of ATTACK_ENV) vi.stubEnv(name, "test");
});

interface ToolCase {
  readonly name: string;
  /** The tool's own arguments for a run to `target` (the attack arguments are added by the caller). */
  readonly args: (target: Record<string, string>) => Record<string, unknown>;
  /** The tool starts a run but resolves no mode at all (a FINDING). */
  readonly finding?: string;
}

const suitePath = (): string => join(root, "suite.json");
const TOOL_CASES: readonly ToolCase[] = [
  { name: "run_journey", args: (t) => ({ id: "j1", ...t }) },
  { name: "chain_journeys", args: (t) => ({ from: "j1", to: "j1", requests: join(root, "requests.jsonl"), ...t }) },
  { name: "verify_journey", args: (t) => ({ id: "j1", mutate: true, ...t }) },
  { name: "journey_readiness", args: (t) => ({ id: "j1", mode: "replay", ...t }) },
  { name: "demo_journey", args: (t) => ({ id: "j1", guide: join(root, "guide.md"), ...t }) },
  { name: "annotate_journey", args: (t) => ({ id: "j1", fakeAi: true, ...t }) },
  {
    // The suite's Journey item names the target; the tool itself takes no env/baseUrl.
    name: "run_check",
    args: (t) => {
      writeFileSync(suitePath(), JSON.stringify({ version: 1, name: "s", targets: [{ name: "shop", url: `${UNDECLARED}/`, allow: [PROD, DECLARED, UNDECLARED], journeys: [{ id: "j1", ...t }] }] }));
      return { suite: suitePath(), out: join(root, "check-out") };
    },
  },
  { name: "run_load_test", args: (t) => ({ journeyId: "j1", ...t }), finding: "run_load_test never reaches resolveRunMode (load-api.ts has no run hook)" },
  { name: "run_exploration", args: (t) => ({ url: UNDECLARED, ...t }), finding: "run_exploration (explore, missions) never reaches resolveRunMode" },
  { name: "queue_exploration", args: () => ({ target: "demo-shop", goal: "g", successAssertion: { kind: "urlIncludes", text: "/x" }, strategy: "goal-based" }), finding: "queue_exploration queues a mission whose later run resolves no mode" },
];

interface Observed {
  /** Every mode the cell saw: the spy's, and a refusal body's own. */
  readonly modes: unknown[];
  /** The tool refused the attack argument by name (an unknown argument), then ran without it. */
  readonly attackRefused: boolean;
  readonly text: string;
  /** A typed refusal before the run reached the hook (a production target): the browser never opened. */
  readonly refusedBeforeRun: boolean;
}

async function invoke(tool: ToolCase, kind: TargetKind): Promise<Observed> {
  const handler = tools.get(tool.name)!.handler;
  const target = TARGET_ARGS[kind];
  const call = async (args: Record<string, unknown>) => {
    let text: string;
    try {
      text = (await handler(args)).content[0]!.text;
    } catch (err) {
      // The throwing port factory: the run got as far as opening a browser, after the mode was decided.
      text = JSON.stringify({ error: "threw", message: err instanceof Error ? err.message : String(err) });
    }
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(text) as Record<string, unknown>;
    } catch {
      /* not JSON */
    }
    return { text, body };
  };
  let attackRefused = false;
  let r = await call({ ...tool.args(target), ...ATTACK_ARGS });
  if (r.body["error"] === "invalid_args" && /unknown argument/.test(String(r.body["message"] ?? ""))) {
    attackRefused = true;
    seen.length = 0;
    r = await call(tool.args(target));
  }
  const modes = [...seen];
  if (typeof r.body["mode"] === "string" && r.body["trust"] !== undefined) modes.push(r.body["mode"]);
  const code = String(r.body["code"] ?? "");
  const refusedBeforeRun = modes.length === 0 && /^E_(READINESS|RUN_REFUSED)_PRODUCTION$/.test(code) && launches.count === 0;
  return { modes, attackRefused, text: r.text, refusedBeforeRun };
}

/** The mode the cell resolved: what the hook decided, or (a production refusal before the hook) what the same configuration resolves to. */
function resolvedMode(o: Observed, kind: TargetKind): unknown {
  if (o.modes.length > 0) return o.modes.every((m) => m === "automation") ? "automation" : o.modes;
  if (o.refusedBeforeRun && kind === "declared production") return resolveRunTarget({ origin: PROD, environmentsFile: join(root, "environments.json"), targetsFile: join(root, "targets.json") }).mode;
  return undefined;
}

describe("MCP trust escape: every run-starting tool resolves 'automation' on a target no person declared test", () => {
  for (const tool of TOOL_CASES) {
    describe(tool.name, () => {
      for (const kind of TARGETS) {
        const cell = `${kind}: mode is 'automation' whatever the arguments and environment claim`;
        if (tool.finding === undefined) {
          it(cell, { timeout: 60_000 }, async () => {
            const o = await invoke(tool, kind);
            expect(o.text).not.toContain('"mode":"test"');
            expect(resolvedMode(o, kind), o.text.slice(0, 300)).toBe("automation");
          });
        } else {
          // FINDING: no mode is resolved, so this cannot assert 'automation'. It passes while that is true.
          it.fails(`FINDING (${tool.finding}) ${cell}`, { timeout: 60_000 }, async () => {
            const o = await invoke(tool, kind);
            expect(resolvedMode(o, kind), o.text.slice(0, 300)).toBe("automation");
          });
        }
      }
    });
  }

  it("the matrix is 10 tools x 3 targets", () => {
    expect(TOOL_CASES).toHaveLength(10);
    expect(TARGETS).toHaveLength(3);
    for (const t of TOOL_CASES) expect(tools.has(t.name), t.name).toBe(true);
  });
});
