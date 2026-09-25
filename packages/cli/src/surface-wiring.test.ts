import { dirname, join, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import ts from "typescript";

/**
 * Surface wiring (the orphan/brownout guard). Every user-facing surface — the `explore` CLI, the
 * `mission run` queue (what MCP `queue_exploration` feeds), `check` suites, MCP `verify_fix`, `ux` —
 * reaches the engine through the mission APIs (`runExploration`, `runCoverageMission`, …). A mission
 * option that one surface passes and another silently drops is a brownout: the capability exists
 * but that surface cannot reach it (a queued mission ignoring the operator's targets.json safety).
 *
 * The type checker diffs each call's argument against the API's option type (spreads included).
 * Every option a surface does not pass must be listed below WITH A REASON; an unlisted omission
 * fails, and so does a listed one that is no longer omitted (the list only ever describes today).
 * Adding an engine option therefore forces a decision for every surface.
 */

const CLI_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The mission APIs a surface reaches the engine through (called directly, or via `check`'s runner table). */
const APIS = new Set([
  "runExploration",
  "runCoverageMission",
  "runAdversarialCliMission",
  "runFeatureCliMission",
  "runUsabilityMission",
  "runUxReview",
  "runVerifyFix",
  "runRegressionCapture",
  "runRegressionRun",
  "runExploreMultiRun",
  "runCheck",
]);
/** `check`'s runner table (`runners.goal(…)`): its keys name the API they stand for. */
const RUNNER_KEYS: Readonly<Record<string, string>> = {
  goal: "runExploration",
  coverage: "runCoverageMission",
  adversarial: "runAdversarialCliMission",
  feature: "runFeatureCliMission",
  usability: "runUsabilityMission",
  verifyFix: "runVerifyFix",
};

const SEAM = "test seam (clock / headless / injected ports) — never a user setting";
const MCP_NARROW = "MCP verify_fix takes only a result id + fingerprint: operator settings come from targets.json, never an MCP argument";
const QUEUE_NO_ENV_SECRETS = "a queued spec's authFrom.secret is refused at enqueue: a request never chooses which env var is sent";
const QUEUE_NARROW = "a queued mission carries only what MissionRequest allows (a closed schema an MCP agent fills)";

/** `<file> <api>` → option → why that surface does not pass it. */
const OMISSIONS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  // ── explore CLI: the reference surface ──────────────────────────────────────────────────────
  "program.ts runExploration": { successAssertion: "the CLI passes --success as successChecks", nowIso: SEAM },
  "program.ts runCoverageMission": { nowIso: SEAM },
  "program.ts runAdversarialCliMission": { headless: SEAM, nowIso: SEAM },
  "program.ts runFeatureCliMission": { headless: SEAM, nowIso: SEAM },
  "program.ts runExploreMultiRun": { nowIso: SEAM },
  "program.ts runVerifyFix": { settleCeilingMs: "verify-fix reuses the recorded run's render wait" },
  "program.ts runUsabilityMission": {
    env: SEAM,
    configPath: SEAM,
    signals: SEAM,
    judgmentBudget: "fixed default budget; no CLI flag",
    nowIso: SEAM,
    extractText: SEAM,
  },
  "program.ts runUxReview": {
    env: SEAM,
    configPath: SEAM,
    signals: SEAM,
    judgmentBudget: "fixed default budget; no CLI flag",
    nowIso: SEAM,
    secrets: "offline review of a finished result: no live page to redact",
    fixture: "offline review: nothing to upload",
  },
  "program.ts runRegressionCapture": {},
  "program.ts runRegressionRun": {},
  "check-cli.ts runCheck": { env: SEAM, now: SEAM, nowIso: SEAM },
  "mcp-api.ts runVerifyFix": {
    storageState: MCP_NARROW,
    browserPortFactory: SEAM,
    browser: SEAM,
    settleCeilingMs: MCP_NARROW,
    replays: MCP_NARROW,
    invariantFiles: MCP_NARROW,
    allowLogCmd: MCP_NARROW,
    hangReplayWrites: MCP_NARROW,
    fixtureFlags: MCP_NARROW,
    secrets: MCP_NARROW,
    emulation: "replays under the finding's own recorded emulation",
    allowEmulationOverride: MCP_NARROW,
  },

  // ── mission run queue (MCP queue_exploration) ───────────────────────────────────────────────
  "mission-queue-runner.ts runExploration": {
    successChecks: "a queued goal carries one successAssertion",
    successWhen: QUEUE_NARROW,
    secrets: "redaction comes from the target's secret fields",
    fixture: QUEUE_NARROW,
    nowIso: SEAM,
    filing: QUEUE_NARROW,
    issueFiler: QUEUE_NARROW,
    hangReplays: QUEUE_NARROW,
    conversation: QUEUE_NARROW,
    invariantAuthTokens: QUEUE_NO_ENV_SECRETS,
    actors: QUEUE_NARROW,
  },
  "mission-queue-runner.ts runCoverageMission": {
    nowIso: SEAM,
    invariantAuthTokens: QUEUE_NO_ENV_SECRETS,
    strategy: "the queue has no exploratory strategy (MISSION_STRATEGIES)",
    stallTimeoutMs: QUEUE_NARROW,
    overflow: QUEUE_NARROW,
  },
  "mission-queue-runner.ts runAdversarialCliMission": {
    headless: SEAM,
    secrets: "redaction comes from the target's secret fields",
    filing: QUEUE_NARROW,
    issueFiler: QUEUE_NARROW,
    hangReplays: QUEUE_NARROW,
    nowIso: SEAM,
    coverageThresholds: QUEUE_NARROW,
    invariantAuthTokens: QUEUE_NO_ENV_SECRETS,
    overflow: QUEUE_NARROW,
  },
  "mission-queue-runner.ts runFeatureCliMission": {
    headless: SEAM,
    stallTimeoutMs: QUEUE_NARROW,
    nowIso: SEAM,
    invariantAuthTokens: QUEUE_NO_ENV_SECRETS,
  },

  // ── check suites ────────────────────────────────────────────────────────────────────────────
  "check-api.ts runExploration": {
    successAssertion: "a suite goal passes success specs as successChecks",
    secrets: "redaction comes from the target's secret fields",
    fixture: "a suite goal has no upload fixture field",
    saveStorageState: "a suite never rewrites the operator's session file",
    nowIso: SEAM,
    filing: "check reports findings itself (JUnit/SARIF)",
    issueFiler: "check reports findings itself (JUnit/SARIF)",
    hangReplays: "fixed default replays in CI",
    conversation: "fixed default conversation settings",
    emulation: "a suite item has no viewport/device field",
    actors: "a suite item has no actors field",
  },
  "check-api.ts runCoverageMission": {
    saveStorageState: "a suite never rewrites the operator's session file",
    nowIso: SEAM,
    strategy: "a suite has no exploratory strategy",
    stallTimeoutMs: "fixed default in CI",
    emulation: "a suite item has no viewport/device field",
    overflow: "fixed default in CI",
  },
  "check-api.ts runAdversarialCliMission": {
    headless: SEAM,
    saveStorageState: "a suite never rewrites the operator's session file",
    secrets: "redaction comes from the target's secret fields",
    filing: "check reports findings itself (JUnit/SARIF)",
    issueFiler: "check reports findings itself (JUnit/SARIF)",
    hangReplays: "fixed default replays in CI",
    nowIso: SEAM,
    coverageThresholds: "fixed default thresholds in CI",
    emulation: "a suite item has no viewport/device field",
    overflow: "fixed default in CI",
  },
  "check-api.ts runFeatureCliMission": {
    headless: SEAM,
    stallTimeoutMs: "fixed default in CI",
    nowIso: SEAM,
    saveStorageState: "a suite never rewrites the operator's session file",
    emulation: "a suite item has no viewport/device field",
  },
  "check-api.ts runUsabilityMission": {
    minConfidence: "fixed default in CI",
    show: "usability findings are advisory in check",
    env: SEAM,
    configPath: SEAM,
    secrets: "redaction comes from the target's secret fields",
    signals: SEAM,
    fixture: "a suite item has no upload fixture field",
    judgmentBudget: "fixed default budget",
    conversation: "fixed default conversation settings",
    emulation: "a suite item has no viewport/device field",
    saveStorageState: "a suite never rewrites the operator's session file",
    nowIso: SEAM,
    extractText: SEAM,
    overflow: "fixed default in CI",
    invariants: "usability refuses declared invariants (#150)",
    invariantAuthTokens: "usability refuses declared invariants (#150)",
  },
  "check-api.ts runVerifyFix": {
    settleCeilingMs: "verify-fix reuses the recorded run's render wait",
    invariantFiles: "the result persists its invariant spec",
    allowLogCmd: "never enabled from a suite; targets.json may opt in",
    hangReplayWrites: "never from a suite; targets.json may opt in",
    fixtureFlags: "the target's fixtures come from targets.json",
    secrets: "redaction comes from the target's secret fields",
    emulation: "replays under the finding's own recorded emulation",
    allowEmulationOverride: "replays under the finding's own recorded emulation",
  },
};

/**
 * Engine result → the envelope the user reads (`--json`, `<stem>.result.json`, MCP get_mission_result).
 * A result field the envelope drops must say where it went instead (#180: `budget` was computed and
 * never shown). Envelopes that spread the whole mission result (feature, adversarial) drop nothing.
 */
const ENVELOPES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  "GoalBasedResult → RunExplorationResult": {
    run: "flattened: runOutcome, stop, decisions, actions, timing, sideEffects, answer",
    hang: "→ hangs[]",
    warnings: "→ checkWarnings",
    invariantDefects: "→ defects (declaredResult)",
  },
  "ExploreRun → RunExplorationResult": {
    hang: "→ hangs[]",
    heap: "per-step samples; a crash carries them in crash.heap",
    blockingCause: "folded into the run's reason (withCause)",
  },
  "InductionRunResult → RunCoverageMissionResult": {
    recordings: "written to disk → recordingPaths",
    transcript: "written to disk → transcriptPath",
    invariantDefects: "→ defects (declaredResult)",
  },
  "ExploreRun → RunUsabilityMissionResult": {
    recording: "written to disk → recordingPath",
    transcript: "written to disk → transcriptPath",
    heap: "per-step samples; a crash carries them in crash.heap",
    blockingCause: "folded into the run's reason (withCause)",
  },
};

interface Site {
  readonly key: string;
  readonly missing: readonly string[];
}

function cliProgram(): ts.Program {
  const configPath = join(CLI_ROOT, "tsconfig.json");
  const parsed = ts.getParsedCommandLineOfConfigFile(configPath, {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => undefined });
  if (parsed === undefined) throw new Error(`cannot read ${configPath}`);
  return ts.createProgram(parsed.fileNames, parsed.options);
}

/** The property names of a named interface / type alias anywhere in the program (the CLI's or a dependency's). */
function propsOf(program: ts.Program, name: string): Set<string> {
  const checker = program.getTypeChecker();
  for (const sf of program.getSourceFiles()) {
    for (const st of sf.statements) {
      if ((ts.isInterfaceDeclaration(st) || ts.isTypeAliasDeclaration(st)) && st.name.text === name) {
        return new Set(checker.getTypeAtLocation(st.name).getProperties().map((p) => p.name));
      }
    }
  }
  throw new Error(`type ${name} not found`);
}

/** Every call from a non-test CLI source to a mission API, with the options its argument never sets. */
function wiringSites(program: ts.Program): Site[] {
  const checker = program.getTypeChecker();
  const byKey = new Map<string, Set<string>>();
  for (const sf of program.getSourceFiles()) {
    if (!sf.fileName.startsWith(join(CLI_ROOT, "src")) || /\.test\.ts$/.test(sf.fileName)) continue;
    const visit = (n: ts.Node): void => {
      if (ts.isCallExpression(n) && n.arguments.length > 0) {
        const callee = ts.isIdentifier(n.expression) ? n.expression.text : ts.isPropertyAccessExpression(n.expression) ? n.expression.name.text : null;
        const onRunners = ts.isPropertyAccessExpression(n.expression) && /\brunners$/.test(n.expression.expression.getText(sf));
        const api = callee === null ? null : onRunners ? (RUNNER_KEYS[callee] ?? null) : APIS.has(callee) ? callee : null;
        const param = api === null ? undefined : checker.getResolvedSignature(n)?.parameters[0];
        if (api !== null && param !== undefined) {
          const want = checker.getTypeOfSymbolAtLocation(param, n).getProperties().map((p) => p.name);
          const argType = checker.getTypeAtLocation(n.arguments[0] as ts.Expression);
          const have = new Set(argType.getProperties().map((p) => p.name));
          if (argType.isUnion()) for (const t of argType.types) for (const p of t.getProperties()) have.add(p.name);
          const key = `${basename(sf.fileName)} ${api}`;
          const missing = byKey.get(key) ?? new Set<string>(want.filter((w) => !have.has(w)));
          // Called more than once from one file: an option counts as wired only if EVERY call passes it.
          for (const w of want) if (!have.has(w)) missing.add(w);
          byKey.set(key, missing);
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return [...byKey].map(([key, missing]) => ({ key, missing: [...missing].sort() }));
}

const PROGRAM = cliProgram();

describe("surface wiring — every mission option is passed by every surface, or its omission is explained", () => {
  const sites = wiringSites(PROGRAM);

  it("finds the surfaces (the analysis itself is not vacuous)", () => {
    const keys = sites.map((s) => s.key);
    for (const k of ["program.ts runExploration", "mission-queue-runner.ts runFeatureCliMission", "check-api.ts runCoverageMission", "mcp-api.ts runVerifyFix"]) {
      expect(keys, k).toContain(k);
    }
  }, 120_000);

  it("no surface drops a mission option without a stated reason", () => {
    const unexplained = sites.flatMap((s) => s.missing.filter((m) => OMISSIONS[s.key]?.[m] === undefined).map((m) => `${s.key}: ${m}`));
    expect(unexplained, "a surface drops these options: pass them, or add them to OMISSIONS with the reason").toEqual([]);
  }, 120_000);

  it("every listed omission is still an omission (the list never goes stale)", () => {
    const missing = new Map(sites.map((s) => [s.key, new Set(s.missing)]));
    const stale = Object.entries(OMISSIONS).flatMap(([key, opts]) =>
      Object.keys(opts).filter((o) => missing.get(key)?.has(o) !== true).map((o) => `${key}: ${o}`),
    );
    expect(stale, "these are wired now (or the call moved): remove them from OMISSIONS").toEqual([]);
  }, 120_000);
});

describe("result exposure — every engine result field reaches the user's envelope, or says where it went", () => {
  const dropped = Object.keys(ENVELOPES).map((pair) => {
    const [from, to] = pair.split(" → ") as [string, string];
    const have = propsOf(PROGRAM, to);
    return { pair, dropped: [...propsOf(PROGRAM, from)].filter((p) => !have.has(p)).sort() };
  });

  it("no envelope drops an engine result field without a stated destination", () => {
    const unexplained = dropped.flatMap((d) => d.dropped.filter((p) => ENVELOPES[d.pair]?.[p] === undefined).map((p) => `${d.pair}: ${p}`));
    expect(unexplained, "the user never sees these: add them to the envelope, or to ENVELOPES with where they went").toEqual([]);
  });

  it("every listed drop is still a drop (the list never goes stale)", () => {
    const stale = dropped.flatMap((d) => Object.keys(ENVELOPES[d.pair] ?? {}).filter((p) => !d.dropped.includes(p)).map((p) => `${d.pair}: ${p}`));
    expect(stale).toEqual([]);
  });
});

