import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ProfileManager } from "@jevitate/daemon";
import { FsJourneyStore, type Journey } from "@jevitate/journey";
import { FsMissionTargetStore, MissionTargetRegistry } from "@jevitate/missions";
import { buildMcpTools, type McpApiDeps, type McpTool } from "./mcp-api.js";
import { makeInProcessCliRunner } from "./mcp-cli-runner.js";
import { buildProgram } from "./program.js";
import { journeyReviewHash } from "./journey-review.js";
import { registerRunHooks } from "./journey-run-hooks.js";
import { resolveRunTarget } from "./journey-run-mode-gate.js";
import { observeSurfaceRunModes } from "./run-surface-mode.js";
import type { CliDeps } from "./cli-shared.js";

/**
 * 0.30.0 #799 (docs/design/0.30.0-evidence-and-trust.md §5): the MCP trust boundary. For every MCP tool that
 * starts a run, against a declared-production target, a declared target with no trust and a baseUrl nobody
 * declared, the mode the run resolves is 'automation', whatever the arguments claim (a `trust`, a `mode`, a
 * forged environment name) and whatever the process environment says. No browser opens: the port factory throws,
 * and the mode is read from a spy hook placed after the run-mode hook (the mode `resolveRunMode` decided) or from
 * the refusal body's own `mode`, or (for the surfaces that do not replay through the run hooks: a load test, an
 * exploration, a queued exploration, a regression, a finding's verify-fix) from the mode the surface decided
 * (run-surface-mode.ts `observeSurfaceRunModes`).
 *
 * The 0.30.0 gap 4 cells (run_load_test, run_exploration, queue_exploration) were `it.fails` FINDING cells while
 * those tools resolved no mode; they now assert 'automation' like the rest. `regressions run` and `verify_fix`
 * were added with them. `sources run` decides its mode the same way; its gate needs a trusted git source, so it
 * is covered in source-run-api.test.ts instead.
 */

const UNDECLARED = "https://undeclared.example.test";
const PROD = "https://prod.example.test";
const DECLARED = "https://declared.example.test";

type TargetKind = "declared production" | "declared unknown" | "undeclared baseUrl";
const TARGETS: readonly TargetKind[] = ["declared production", "declared unknown", "undeclared baseUrl"];
/** The origin of each target kind, for a tool that takes a URL or a target record rather than an environment. */
const KIND_ORIGIN: Readonly<Record<TargetKind, string>> = { "declared production": PROD, "declared unknown": DECLARED, "undeclared baseUrl": UNDECLARED };
/** A promoted mission target per kind (queue_exploration takes a target id, never a URL). */
const KIND_MISSION_TARGET: Readonly<Record<TargetKind, string>> = { "declared production": "prod-shop", "declared unknown": "declared-shop", "undeclared baseUrl": "undeclared-shop" };
/** A mission result per kind, with one finding (verify_fix takes a result id and a fingerprint). */
const KIND_RESULT: Readonly<Record<TargetKind, string>> = {
  "declared production": "explore-2026-11-08T00-00-00-001Z",
  "declared unknown": "explore-2026-11-08T00-00-00-002Z",
  "undeclared baseUrl": "explore-2026-11-08T00-00-00-003Z",
};
const FINGERPRINT = "0123456789abcdef";

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
    missionTargetsDir: join(root, "mission-targets"),
  } as unknown as CliDeps;
  const deps: McpApiDeps = {
    journeysDir,
    pathRoots: [root],
    runRecordLogsRoot: join(root, "logs"),
    environmentsFile: join(root, "environments.json"),
    targetsConfigPath: join(root, "targets.json"),
    sitePolicyDbPath: join(root, "site.sqlite"),
    browserPortFactory: factory,
    missionTargetsDir: join(root, "mission-targets"),
    missionQueueDir: join(root, "mission-queue"),
    recordingsDir: join(root, "recordings"),
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
  // A person registered and promoted a mission target per kind.
  const missionTargets = new MissionTargetRegistry(new FsMissionTargetStore(join(root, "mission-targets")));
  for (const kind of TARGETS) {
    await missionTargets.put({ id: KIND_MISSION_TARGET[kind], name: kind, authorizedOrigin: KIND_ORIGIN[kind], baseUrl: `${KIND_ORIGIN[kind]}/`, promoted: true, createdAtIso: "2026-11-08T00:00:00.000Z" });
  }
  // A mission result per kind, each with one finding to verify.
  mkdirSync(join(root, "recordings"), { recursive: true });
  for (const kind of TARGETS) {
    const recording = { version: "1", site: KIND_ORIGIN[kind], pages: [{ url: "/", steps: [{ step: { kind: "navigate", url: "/", expect: { kind: "urlIncludes", text: "/" } } }] }] };
    const result = { target: { seedUrl: `${KIND_ORIGIN[kind]}/`, allowlist: [KIND_ORIGIN[kind]] }, recording, defects: [{ fingerprint: FINGERPRINT, kind: "console-error", repro: { recordingStepIndex: 0 } }] };
    writeFileSync(join(root, "recordings", `${KIND_RESULT[kind]}.result.json`), JSON.stringify({ missionOutcome: "defects-found", exitCode: 1, result }));
  }
  // A committed regression, under the project's .jevitate (regression run reads the project's regressions dir).
  mkdirSync(join(root, "project", ".jevitate", "regressions"), { recursive: true });
  writeFileSync(join(root, "project", ".jevitate", "regressions", "r1.recording.json"), JSON.stringify(journey().recording));
  tools = buildTools();
  // After the run-mode hook: validateParams runs with the mode `resolveRunMode` decided.
  registerRunHooks("trust-escape-spy", { validateParams: (ctx) => void seen.push(ctx.mode) });
  // The surfaces outside the run hooks: the mode each decided.
  observeSurfaceRunModes((decided) => void seen.push(decided.mode));
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
  readonly args: (target: Record<string, string>, kind: TargetKind) => Record<string, unknown>;
  /** The tool reads the project dir from the working directory (regression run): run the cell there. */
  readonly inProject?: true;
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
  { name: "run_load_test", args: (t) => ({ journeyId: "j1", authorizedOrigin: [PROD, DECLARED, UNDECLARED], ...t }) },
  // An exploration takes a URL (an environment only with fromJourney): the kind's origin.
  { name: "run_exploration", args: (_t, kind) => ({ url: `${KIND_ORIGIN[kind]}/`, goal: "g", fakeAi: true }) },
  // A queued exploration names a promoted target; the mode is the one its later run decides from the same files.
  { name: "queue_exploration", args: (_t, kind) => ({ target: KIND_MISSION_TARGET[kind], goal: "g", successAssertion: { kind: "urlIncludes", text: "/x" }, strategy: "goal-based" }) },
  { name: "regressions", args: (t) => ({ action: "run", id: "r1", ...t }), inProject: true },
  { name: "verify_fix", args: (_t, kind) => ({ id: KIND_RESULT[kind], fingerprint: FINGERPRINT, replays: 1 }) },
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
  const cwd = tool.inProject === true ? vi.spyOn(process, "cwd").mockReturnValue(join(root, "project")) : undefined;
  let r: Awaited<ReturnType<typeof call>>;
  try {
    r = await call({ ...tool.args(target, kind), ...ATTACK_ARGS });
    const message = String(r.body["message"] ?? "");
    // An unknown argument refused by name: by the CLI tools' arg check, or a queued request's closed schema.
    if ((r.body["error"] === "invalid_args" && /unknown argument/.test(message)) || (r.body["error"] === "queue_exploration_refused" && /unrecognized key/i.test(message))) {
      attackRefused = true;
      seen.length = 0;
      r = await call(tool.args(target, kind));
    }
  } finally {
    cwd?.mockRestore();
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
        it(`${kind}: mode is 'automation' whatever the arguments and environment claim`, { timeout: 60_000 }, async () => {
          const o = await invoke(tool, kind);
          expect(o.text).not.toContain('"mode":"test"');
          expect(resolvedMode(o, kind), o.text.slice(0, 300)).toBe("automation");
        });
      }
    });
  }

  it("queue_exploration records the mode its run will be in, as run.mode and run.target.trust", async () => {
    const o = await invoke(TOOL_CASES.find((t) => t.name === "queue_exploration")!, "declared production");
    expect(JSON.parse(o.text)).toMatchObject({ status: "queued", run: { mode: "automation", target: { origin: PROD, trust: "production" } } });
  });

  it("the matrix is 12 tools x 3 targets", () => {
    expect(TOOL_CASES).toHaveLength(12);
    expect(TARGETS).toHaveLength(3);
    for (const t of TOOL_CASES) expect(tools.has(t.name), t.name).toBe(true);
  });
});
