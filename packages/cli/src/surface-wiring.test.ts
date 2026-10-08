import { dirname, join, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import ts from "typescript";
import type { Command } from "commander";
import { ProfileManager } from "@jevitate/daemon";
import { buildProgram } from "./program.js";

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
  "runLedgerVerify",
  "runRegressionCapture",
  "runRegressionRun",
  "runExploreMultiRun",
  "runCheck",
  "runJourneyProgrammatically",
  "runJourneyLoadTest",
  "runSourceJourney",
]);
/** `check`'s runner table (`runners.goal(…)`): its keys name the API they stand for. */
const RUNNER_KEYS: Readonly<Record<string, string>> = {
  journey: "runJourneyProgrammatically",
  goal: "runExploration",
  coverage: "runCoverageMission",
  adversarial: "runAdversarialCliMission",
  feature: "runFeatureCliMission",
  usability: "runUsabilityMission",
  verifyFix: "runVerifyFix",
};

const SEAM = "test seam (clock / injected ports) — never a user setting";
const MCP_NARROW = "#255: MCP verify_fix takes the CLI's replay options, but operator-only settings (cmd: log sources, re-sending paid/destructive hang writes, redaction literals) come from targets.json, never an MCP argument";
const QUEUE_NO_ENV_SECRETS = "a queued spec's authFrom.secret is refused at enqueue: a request never chooses which env var is sent";
const SITE_ACCOUNT = "the site-policy account is `primary`, the `jevitate site policy` default";
const ANNOTATE_OBSERVER = "#246: only `journey annotate` replays with an observing interpreter (before/after evidence); every run uses the plain one";
const QUEUE_NARROW = "a queued mission carries only what MissionRequest allows (a closed schema an MCP agent fills)";
const MASK_INTERNAL = "#250/#251: the pixel mask is built inside the run from the Journey's secret params; only a demo shares its own";
const OBSERVER_INTERNAL = "#246/#248: only annotate and demo replay with an observer (evidence, captions); `--screenshots` composes its own inside the run";
const OBSERVER_NOT_INTERPRETER = "#251: annotate/demo pass their observer (`observer`) so `--screenshots` can compose with it; never a whole interpreter";
const EVIDENCE_PACE = "#250: the after-clip's caption pace is fixed (EVIDENCE_PACE_MS); a test seam only";
const NO_DELTAS_HERE = "#303: --action-deltas is a per-run opt-in on explore items, journey run/annotate/demo and verify-fix; this batch/suite/candidate replay only needs its verdict";
const NO_SCREENSHOTS_HERE = "#251: this surface takes no --screenshots (a batch/queued/MCP/suite-journey run: none asked for)";
const WHOLE_JOURNEY = "#293: only an anchored mission replays a Journey PREFIX into its own open session (journey-prefix.ts); this surface replays the whole Journey in a browser of its own";
const PREFIX_IN_SESSION = "#293: a Journey prefix replays INTO the mission's already-open session — the mission's own browser, emulation and capture apply";
const BRANCH_RECORDED = "#293: a branch-point finding still replays through its Journey prefix, with the params its result recorded (non-secret); secret ones are re-supplied only on `verify-fix --param`";
const NO_ANCHORED_HERE = "#293: a journey-anchored mission is an `explore --from-journey` run, a suite mission item or a campaign job — never this surface";

/** `<file> <api>` → option → why that surface does not pass it. */
const OMISSIONS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  // ── explore CLI: the reference surface ──────────────────────────────────────────────────────
  "explore-cli.ts runExploration": { hostHealth: SEAM, successAssertion: "the CLI passes --success as successChecks", nowIso: SEAM },
  // #369: every explore-author-journey take is explore's goal run — what authoring leaves out, and why.
  "explore-author.ts runExploration": {
    hostHealth: SEAM,
    nowIso: SEAM,
    successAssertion: "authorJourney hands every check (successAssertion included) to the take as successChecks",
    actors: "an authored Journey drives one session: multi-actor (--actor) missions are explore's",
    evidenceVideo: "authoring files nothing: a take's issue drafts stay next to its result; `explore --evidence-video` attaches media",
    filing: "authoring files nothing: a take's issue drafts stay next to its result (drafts only)",
    issueFiler: "authoring files nothing: a take's issue drafts stay next to its result (drafts only)",
    fixtures: "mission fixtures (--fixtures/--before/--after) run operator hooks around one mission; an author run starts from --storage-state",
    invariants: "authoring adjudicates by the goal's own checks; app invariants are `explore --invariants` on the authored path",
    invariantAuthTokens: "authoring adjudicates by the goal's own checks; app invariants are `explore --invariants` on the authored path",
    journeyPrefix: NO_ANCHORED_HERE,
    minEffort: "#424: every take is checked by --success and stops at the first verified path; a minimum effort would only delay it (`explore --min-actions`)",
    serverLog: "backend log sources are operator-declared `explore --log-source`; authoring needs only the goal's checks",
  },
  "explore-cli.ts runCoverageMission": { hostHealth: SEAM, nowIso: SEAM },
  "explore-cli.ts runAdversarialCliMission": { hostHealth: SEAM, nowIso: SEAM },
  "explore-cli.ts runFeatureCliMission": { hostHealth: SEAM, nowIso: SEAM },
  "explore-cli.ts runExploreMultiRun": { nowIso: SEAM },
  "verify-fix-cli.ts runVerifyFix": { settleCeilingMs: "verify-fix reuses the recorded run's render wait", evidencePaceMs: EVIDENCE_PACE },
  "explore-cli.ts runUsabilityMission": {
    hostHealth: SEAM,
    env: SEAM,
    configPath: SEAM,
    signals: SEAM,
    judgmentBudget: "fixed default budget; no CLI flag",
    nowIso: SEAM,
    extractText: SEAM,
  },
  "ux-cli.ts runUxReview": {
    env: SEAM,
    configPath: SEAM,
    signals: SEAM,
    judgmentBudget: "fixed default budget; no CLI flag",
    nowIso: SEAM,
    secrets: "offline review of a finished result: no live page to redact",
    fixture: "offline review: nothing to upload",
  },
  "ledger-cli.ts runLedgerVerify": {
    actionDeltas: NO_DELTAS_HERE,
    evidencePaceMs: EVIDENCE_PACE,
    screenshots: NO_SCREENSHOTS_HERE,
    settleCeilingMs: "verify-fix reuses the recorded run's render wait",
    invariantFiles: "a ledger entry carries the invariant spec it is re-checked with",
    hangReplayWrites: "never in a batch re-check; verify-fix <fp> --hang-replay-writes re-checks one hang",
    fixtureFlags: "a fixture's shell hooks are re-supplied per finding: verify-fix <fp> --before/--after",
    secrets: "redaction of fixture logs only; a batch re-check takes no fixture hooks",
    emulation: "replays under each finding's own recorded emulation",
    allowEmulationOverride: "replays under each finding's own recorded emulation",
    journeyPrefix: BRANCH_RECORDED,
  },
  "regression-cli.ts runRegressionCapture": {},
  "regression-cli.ts runRegressionRun": {},
  "check-cli.ts runCheck": { env: SEAM, now: SEAM, nowIso: SEAM },
  "mcp-api.ts runVerifyFix": {
    evidencePaceMs: EVIDENCE_PACE,
    browserPortFactory: SEAM,
    settleCeilingMs: "verify-fix reuses the recorded run's render wait",
    allowLogCmd: MCP_NARROW,
    hangReplayWrites: MCP_NARROW,
    secrets: MCP_NARROW,
    journeyPrefix: BRANCH_RECORDED,
  },

  // ── Journeys ────────────────────────────────────────────────────────────────────────────────
  "journey-cli.ts runJourneyProgrammatically": { account: SITE_ACCOUNT, interpreter: ANNOTATE_OBSERVER, mask: MASK_INTERNAL, observer: OBSERVER_INTERNAL, session: WHOLE_JOURNEY, stopAfterStep: WHOLE_JOURNEY },
  "journey-prefix.ts runJourneyProgrammatically": {
    account: SITE_ACCOUNT,
    actionDeltas:
      "#303 × #293: the prefix is the anchored mission's setup, not its actions — `--action-deltas` records the mission's own steps from the branch point on; a prefix that no longer replays is already a typed journey-stale (fail-closed), never a delta mismatch",
    browserPortFactory: PREFIX_IN_SESSION,
    emulation: PREFIX_IN_SESSION,
    mask: PREFIX_IN_SESSION,
    screenshots: PREFIX_IN_SESSION,
    fixtures: "#293: the anchored run's caller owns the state (explore --fixtures around a goal run; a campaign's restore around every run)",
    interpreter: ANNOTATE_OBSERVER,
    observer: OBSERVER_INTERNAL,
    policy: "#293: a prefix replays with the fail-closed safeRunPolicy() — paid/destructive steps refused as in any run",
    selfHealer: "#293: a prefix never self-heals: a healed prefix is no branch point — it is a stale Journey (journey-stale)",
  },
  "journey-annotate-api.ts runJourneyProgrammatically": {
    interpreter: OBSERVER_NOT_INTERPRETER,
    policy: "annotate replays with the fail-closed safeRunPolicy() — it documents a Journey, never heals one",
    selfHealer: "annotate never self-heals: a broken step stops the replay and drafts only the reached steps",
  },
  "journey-demo-api.ts runJourneyProgrammatically": {
    interpreter: OBSERVER_NOT_INTERPRETER,
    policy: "a demo replays with the fail-closed safeRunPolicy() — paid/destructive steps refused as in any run",
    selfHealer: "a demo never self-heals: a Journey that no longer replays is a stale demo (exit 1)",
  },
  "demo-aspect-api.ts runJourneyProgrammatically": {
    actionDeltas: NO_DELTAS_HERE,
    account: SITE_ACCOUNT,
    interpreter: "#249: a clean-path candidate replay only needs its verdict (the demo/annotate stages observe their own replays)",
    policy: "a clean-path candidate replays with the fail-closed safeRunPolicy() — paid/destructive steps refused as in any run",
    selfHealer: "a clean-path candidate never self-heals: a step it cannot do without is kept",
    mask: "a clean-path candidate captures no media (the demo stage masks its own)",
    observer: OBSERVER_INTERNAL,
    screenshots: "a clean-path candidate captures no media (the demo stage renders the screenshots)",
    session: WHOLE_JOURNEY,
    stopAfterStep: WHOLE_JOURNEY,
  },
  "load-cli.ts runJourneyLoadTest": { policy: "a load run replays with the fail-closed safeRunPolicy()" },
  "mcp-api.ts runJourneyProgrammatically": {
    mask: MASK_INTERNAL,
    observer: OBSERVER_INTERNAL,
    account: SITE_ACCOUNT,
    browserPortFactory: SEAM,
    interpreter: ANNOTATE_OBSERVER,
    session: WHOLE_JOURNEY,
    stopAfterStep: WHOLE_JOURNEY,
  },
  "check-execute.ts runJourneyProgrammatically": {
    actionDeltas: NO_DELTAS_HERE,
    mask: MASK_INTERNAL,
    observer: OBSERVER_INTERNAL,
    screenshots: NO_SCREENSHOTS_HERE,
    account: SITE_ACCOUNT,
    policy: "a suite Journey replays with the fail-closed safeRunPolicy()",
    selfHealer: "check never self-heals: a broken step fails the gate",
    interpreter: ANNOTATE_OBSERVER,
    session: WHOLE_JOURNEY,
    stopAfterStep: WHOLE_JOURNEY,
  },

  // ── mission run queue (MCP queue_exploration) ───────────────────────────────────────────────
  "mission-queue-runner.ts runExploration": {
    secretCommand: "#324: a cmd: secret source runs an operator command — explore --allow-secret-cmd only, never a queued or suite mission",
    secretCommandAttempts: "#359: the bound on a cmd: secret source's command runs — goes with secretCommand (explore --allow-secret-cmd only)",
    hostHealth: SEAM,
    successChecks: "a queued goal carries one successAssertion",
    successWhen: QUEUE_NARROW,
    allowVacuousChecks: QUEUE_NARROW,
    actionDeltas: QUEUE_NARROW,
    secrets: "redaction comes from the target's secret fields",
    fixture: QUEUE_NARROW,
    typeFixtures: QUEUE_NARROW,
    nowIso: SEAM,
    filing: QUEUE_NARROW,
    issueFiler: QUEUE_NARROW,
    hangReplays: QUEUE_NARROW,
    conversation: QUEUE_NARROW,
    invariantAuthTokens: QUEUE_NO_ENV_SECRETS,
    actors: QUEUE_NARROW,
    journeyPrefix: NO_ANCHORED_HERE,
  },
  "mission-queue-runner.ts runCoverageMission": {
    actionDeltas: QUEUE_NARROW,
    hostHealth: SEAM,
    nowIso: SEAM,
    invariantAuthTokens: QUEUE_NO_ENV_SECRETS,
    stallTimeoutMs: QUEUE_NARROW,
    overflow: QUEUE_NARROW,
    journeyPrefix: NO_ANCHORED_HERE,
  },
  "mission-queue-runner.ts runAdversarialCliMission": {
    actionDeltas: QUEUE_NARROW,
    hostHealth: SEAM,
    secrets: "redaction comes from the target's secret fields",
    filing: QUEUE_NARROW,
    issueFiler: QUEUE_NARROW,
    hangReplays: QUEUE_NARROW,
    nowIso: SEAM,
    coverageThresholds: QUEUE_NARROW,
    invariantAuthTokens: QUEUE_NO_ENV_SECRETS,
    overflow: QUEUE_NARROW,
    journeyPrefix: NO_ANCHORED_HERE,
  },
  "mission-queue-runner.ts runFeatureCliMission": {
    hostHealth: SEAM,
    stallTimeoutMs: QUEUE_NARROW,
    nowIso: SEAM,
    invariantAuthTokens: QUEUE_NO_ENV_SECRETS,
  },

  // ── check suites ────────────────────────────────────────────────────────────────────────────
  "check-execute.ts runExploration": {
    secretCommand: "#324: a cmd: secret source runs an operator command — explore --allow-secret-cmd only, never a queued or suite mission",
    secretCommandAttempts: "#359: the bound on a cmd: secret source's command runs — goes with secretCommand (explore --allow-secret-cmd only)",
    hostHealth: SEAM,
    typeFixtures: "#281: a file typed verbatim is an explore --type-fixture binding; a suite goal declares none",
    successAssertion: "a suite goal passes success specs as successChecks",
    nowIso: SEAM,
    filing: "check reports findings itself (JUnit/SARIF)",
    issueFiler: "check reports findings itself (JUnit/SARIF)",
    journeyPrefix: "#293: a suite's journey-anchored items are mission items (fromJourney/atStep); a goal item starts at its url",
  },
  "check-execute.ts runCoverageMission": {
    hostHealth: SEAM,
    nowIso: SEAM,
  },
  "check-execute.ts runAdversarialCliMission": {
    hostHealth: SEAM,
    filing: "check reports findings itself (JUnit/SARIF)",
    issueFiler: "check reports findings itself (JUnit/SARIF)",
    nowIso: SEAM,
  },
  "check-execute.ts runFeatureCliMission": {
    hostHealth: SEAM,
    nowIso: SEAM,
  },
  "check-execute.ts runUsabilityMission": {
    secretCommand: "#324: a cmd: secret source runs an operator command — explore --allow-secret-cmd only, never a queued or suite mission",
    secretCommandAttempts: "#359: the bound on a cmd: secret source's command runs — goes with secretCommand (explore --allow-secret-cmd only)",
    hostHealth: SEAM,
    env: SEAM,
    configPath: SEAM,
    signals: SEAM,
    judgmentBudget: "fixed default budget",
    nowIso: SEAM,
    extractText: SEAM,
    invariants: "usability refuses declared invariants (#150)",
    invariantAuthTokens: "usability refuses declared invariants (#150)",
  },
  "check-execute.ts runVerifyFix": {
    actionDeltas: NO_DELTAS_HERE,
    evidencePaceMs: EVIDENCE_PACE,
    screenshots: NO_SCREENSHOTS_HERE,
    settleCeilingMs: "verify-fix reuses the recorded run's render wait",
    invariantFiles: "the result persists its invariant spec",
    allowLogCmd: "never enabled from a suite; targets.json may opt in",
    hangReplayWrites: "never from a suite; targets.json may opt in",
    fixtureFlags: "the target's fixtures come from targets.json",
    secrets: "redaction comes from the target's secret fields",
    emulation: "replays under the finding's own recorded emulation",
    allowEmulationOverride: "replays under the finding's own recorded emulation",
    journeyPrefix: BRANCH_RECORDED,
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
    doneRejected: "folded into the goal outcome: `failed` (a done code rejected), never `blocked` (#209)",
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
    doneRejected: "folded into outcome.reason (the model proposed done N times…) and failure job-incomplete (#209)",
    partialReport: "#424: a usability review is judged by its UX findings and the job's checks, never by a reported answer",
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
    for (const k of ["explore-cli.ts runExploration", "mission-queue-runner.ts runFeatureCliMission", "check-execute.ts runCoverageMission", "mcp-api.ts runVerifyFix"]) {
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

/** Commands that take a session/emulation flag but never open a browser themselves (they store config). */
const NOT_BROWSER_COMMANDS: Readonly<Record<string, string>> = {
  "mission target add": "stores a target's session path; `mission run` opens the browser",
  "mission target update": "stores a target's session path; `mission run` opens the browser",
  "mission queue": "only enqueues the viewport/device (#254, MCP queue_exploration); `mission run` opens the browser",
};

describe("flag exposure — every browser-opening command takes the shared --browser-* launch flags", () => {
  const commands: Array<{ path: string; flags: string[] }> = [];
  const walk = (c: Command, path: string): void => {
    commands.push({ path, flags: c.options.map((o) => o.long ?? "") });
    for (const sub of c.commands) walk(sub, path === "" ? sub.name() : `${path} ${sub.name()}`);
  };
  walk(buildProgram({ profiles: new ProfileManager("/unused-in-this-test") }), "");

  it("a command with --viewport or --storage-state (it opens a browser) also takes --browser-executable/-channel/-arg", () => {
    const missing = commands
      .filter((c) => (c.flags.includes("--viewport") || c.flags.includes("--storage-state")) && NOT_BROWSER_COMMANDS[c.path] === undefined)
      .filter((c) => !["--browser-executable", "--browser-channel", "--browser-arg"].every((f) => c.flags.includes(f)))
      .map((c) => c.path);
    expect(missing).toEqual([]);
  });

  it("every NOT_BROWSER_COMMANDS entry still exists", () => {
    const paths = new Set(commands.map((c) => c.path));
    expect(Object.keys(NOT_BROWSER_COMMANDS).filter((p) => !paths.has(p))).toEqual([]);
  });
});

