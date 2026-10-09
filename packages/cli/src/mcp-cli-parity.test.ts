import { describe, expect, it } from "vitest";
import type { Command, Option } from "commander";
import { ProfileManager } from "@jevitate/daemon";
import { ALLOWED_TOOLS, FORBIDDEN_TOOLS } from "@jevitate/mcp-facade";
import { buildProgram } from "./program.js";
import { buildMcpTools } from "./mcp-api.js";
import { CLI_TOOL_SPECS, OMIT, type CliCommandSpec, type CliParam } from "./mcp-cli-tools.js";

/**
 * The CLI ↔ MCP parity guard, both ways.
 *
 * #254 (MCP → CLI): every capability exposed over MCP is also available from the CLI — each
 * `ALLOWED_TOOLS` entry maps to the CLI command(s) that expose it (approve/cancel map to their
 * documented human-only refusals: `inbox approve`/`inbox cancel` refuse exactly as MCP does).
 *
 * #255 (CLI → MCP): MCP is a convenience for LLMs that can already drive the CLI, so every runnable
 * CLI command maps to an MCP tool — or sits in EXCLUDED with the reason it is not one. And for the
 * tools that mirror a command, every one of its flags is an MCP argument or is omitted WITH A
 * REASON, with the argument's shape matching the flag's (boolean / value / optional value /
 * repeatable / positional) — checked against the real commander tree, so a new CLI command or
 * flag without an MCP decision fails here.
 */

/** The hand-written MCP tools (mcp-api.ts) → the CLI command(s) they correspond to. */
const NATIVE_MCP_TO_CLI: Readonly<Record<string, readonly string[]>> = {
  list_incoming: ["inbox list"],
  get_thread: ["inbox show"],
  get_command: ["inbox command"],
  queue_retrieval: ["inbox queue-retrieval"],
  queue_action: ["inbox queue-action"],
  get_site_health: ["inbox health"],
  approve_action: ["inbox approve"], // human-only: always refused (E_HUMAN_APPROVAL_REQUIRED) — approve in `jevitate ui`
  cancel_command: ["inbox cancel"], // human-only: always refused (E_HUMAN_APPROVAL_REQUIRED) — cancel in `jevitate ui`
  find_capabilities: ["journey find"],
  run_journey: ["journey run"],
  ai_generate_text: ["ai generate"],
  queue_exploration: ["mission queue"],
  get_mission_result: ["mission result"],
  verify_fix: ["verify-fix"],
};

/** CLI commands deliberately NOT reachable over MCP, and why. Nothing else may be missing. */
const EXCLUDED: Readonly<Record<string, string>> = {
  mcp: "the MCP server itself (it owns stdin/stdout); an MCP client is already connected to it",
  ui: "the local human dashboard (loopback HTTP, opens a browser): where a person approves/cancels inbox items — human-only by design",
  init: "local machine setup: writes the harness MCP config, installs skills and collects API keys interactively — the operator's, run once",
  "ai setup": "interactive secret entry (a hidden-echo stdin prompt for an API key): a key never passes through a model or an MCP argument",
  record: "a HUMAN-driven recording: a person clicks through the app in a headed browser while it records — there is nobody to click over MCP (author_journey is the agent's way to author a Journey)",
  "source trust": "trusting a third-party Journey (bound to its content hash) is a person's decision, like approve_action: MCP can add, pull and run a source, never vouch for it",
  "logs triage":
    "#313: sends a run's recorded log text (redacted) to the judgment model with --real — an operator opt-in for their own logs, like --log-source itself (operator-declared, never an MCP argument)",
  login:
    "#427: signs in by typing the values of operator environment variables the command line names (--user-env/--password-env) into a page: a request never chooses which of the operator's variables is read (the --secret-field rule). Over MCP a persona's session is refreshed only from the login parameters an operator's personas file declares (run_exploration personas + authCheck)",
  "persona approve":
    "#433: approving a catalog persona is a person's sign-off (bound to its content hash), like source trust: MCP reads the sheet (review_persona), never approves",
  "job approve": "#433: approving a catalog job is a person's sign-off (bound to its content hash), like source trust: MCP reads the sheet (review_job), never approves",
  "install-browser":
    "#450: a host operation (downloads a browser into the machine's shared browsers dir): the operator's, like doctor; MCP tools report a missing browser with this command as the fix",
  "browser-path": "#450: host introspection for project scripts (browsers dir, pinned revision, executable path); no run capability to expose over MCP",
  doctor:
    "#205: host maintenance for the operator (it signals processes on this machine and clears machine-wide browser slots); the same orphan sweep already runs automatically before every browser-driving MCP tool, and each result reports governance in hostHealth.resources",
};

type Kind = CliParam["kind"];
const REPEATABLE: ReadonlySet<Kind> = new Set<Kind>(["string[]", "path[]", "named-sessions", "bound-paths", "params"]);
const OPTIONAL_VALUE: ReadonlySet<Kind> = new Set<Kind>(["optional-path", "optional-session", "screenshots"]);

const program = buildProgram({ profiles: new ProfileManager("/unused-in-parity") });

function commands(root: Command): Map<string, Command> {
  const out = new Map<string, Command>();
  const visit = (c: Command, path: string): void => {
    if (path !== "") out.set(path, c);
    for (const sub of c.commands) if (sub.name() !== "help") visit(sub, path === "" ? sub.name() : `${path} ${sub.name()}`);
  };
  visit(root, "");
  return out;
}
const COMMANDS = commands(program);
/** A command a user can run: it has its own action (a group like `journey` only shows help). */
const runnable = (c: Command): boolean => (c as unknown as { _actionHandler: unknown })._actionHandler != null;
const RUNNABLE = [...COMMANDS].filter(([, c]) => runnable(c)).map(([p]) => p);

const specCommands = (): Array<{ tool: string; action?: string; command: CliCommandSpec }> =>
  CLI_TOOL_SPECS.flatMap((s) =>
    s.command !== undefined ? [{ tool: s.name, command: s.command }] : Object.entries(s.actions ?? {}).map(([action, command]) => ({ tool: s.name, action, command })),
  );

const MCP_TO_CLI: Record<string, string[]> = { ...Object.fromEntries(Object.entries(NATIVE_MCP_TO_CLI).map(([k, v]) => [k, [...v]])) };
for (const { tool, command } of specCommands()) (MCP_TO_CLI[tool] ??= []).push(command.path);

describe("#254: every MCP tool has a CLI command", () => {
  it("maps every ALLOWED_TOOLS entry (and nothing else)", () => {
    expect(Object.keys(MCP_TO_CLI).sort(), "a new MCP tool needs a CLI command and an entry here").toEqual([...ALLOWED_TOOLS].sort());
  });

  it.each(Object.entries(MCP_TO_CLI))("%s → an existing jevitate command", (_tool, paths) => {
    for (const path of paths) expect(COMMANDS.has(path), `jevitate ${path} is not a registered command`).toBe(true);
  });

  it("every served tool is wired — none falls back to a not_implemented stub", () => {
    for (const tool of buildMcpTools({ journeysDir: "/unused", aiGenerateText: async () => ({ value: "" }) as never })) expect(tool.description, tool.name).not.toMatch(/not yet wired/);
  });
});

describe("#255: every CLI command has an MCP tool (or a stated reason it has none)", () => {
  const mapped = new Set(Object.values(MCP_TO_CLI).flat());

  it("finds the command tree (the walk is not vacuous)", () => {
    expect(RUNNABLE.length).toBeGreaterThan(60);
    expect(RUNNABLE).toEqual(expect.arrayContaining(["journey annotate", "journey demo", "demo create", "demo approve", "mission target add"]));
  });

  it("every runnable command maps to an MCP tool or is EXCLUDED with a reason", () => {
    const missing = RUNNABLE.filter((p) => !mapped.has(p) && EXCLUDED[p] === undefined);
    expect(missing, "a new CLI command needs an MCP tool (mcp-cli-tools.ts) or an EXCLUDED entry with the reason").toEqual([]);
  });

  it("EXCLUDED is exact: each entry is a real command, is not also mapped, and has a reason", () => {
    for (const [path, reason] of Object.entries(EXCLUDED)) {
      expect(COMMANDS.has(path), path).toBe(true);
      expect(mapped.has(path), `${path} is excluded but also mapped`).toBe(false);
      expect(reason.length, path).toBeGreaterThan(20);
    }
  });

  it("the raw browser primitives stay off the MCP surface; human-only approvals are served only as refusals", () => {
    const served = new Set(buildMcpTools({ journeysDir: "/unused" }).map((t) => t.name));
    for (const f of FORBIDDEN_TOOLS) expect(served.has(f), f).toBe(false);
    expect(ALLOWED_TOOLS).toEqual(expect.arrayContaining(["approve_action", "cancel_command"])); // always refuse (mcp-api.test)
  });
});

/** A flag's shape as commander parses it. */
function shape(o: Option): "boolean" | "value" | "optional" | "repeatable" {
  const d: unknown = o.defaultValue;
  // Repeatable: a collection default, or a collecting parser (it appends to the previous value).
  const collects = (): boolean => {
    try {
      const r: unknown = (o as unknown as { parseArg?: (v: string, prev: unknown) => unknown }).parseArg?.("v", ["prev"]);
      return Array.isArray(r) && r.includes("prev");
    } catch {
      return false;
    }
  };
  if (o.required) return Array.isArray(d) || (d !== null && typeof d === "object") || collects() ? "repeatable" : "value";
  if (o.optional) return "optional";
  return "boolean";
}
function expectedShape(p: CliParam): ReturnType<typeof shape> {
  if (p.kind === "boolean") return "boolean";
  if (OPTIONAL_VALUE.has(p.kind)) return "optional";
  if (REPEATABLE.has(p.kind)) return "repeatable";
  return "value";
}

describe("#255: a CLI-mirroring tool's arguments are exactly its command's flags and positionals", () => {
  it.each(specCommands().map((c) => [`${c.tool}${c.action === undefined ? "" : ` ${c.action}`} → ${c.command.path}`, c.command] as const))("%s", (_label, spec) => {
    const cmd = COMMANDS.get(spec.path);
    expect(cmd, spec.path).toBeDefined();
    const options = new Map(cmd!.options.map((o) => [o.long ?? "", o]));
    const flagParams = Object.entries(spec.params).filter(([, p]) => p.positional !== true);
    // Each mapped flag exists and has the flag's shape.
    for (const [name, p] of flagParams) {
      const o = options.get(p.flag ?? "");
      expect(o, `${spec.path}: ${name} → ${p.flag} is not a flag of the command`).toBeDefined();
      expect(shape(o!), `${spec.path}: ${name} → ${p.flag}`).toBe(expectedShape(p));
      expect(p.required === true, `${spec.path}: ${name} required ⇔ ${p.flag} mandatory`).toBe(o!.mandatory);
    }
    // Every flag is mapped or omitted with a reason — and the omissions are real flags (never stale).
    const mappedFlags = new Set(flagParams.map(([, p]) => p.flag));
    const uncovered = [...options.keys()].filter((f) => !mappedFlags.has(f) && spec.omitted[f] === undefined);
    expect(uncovered, `${spec.path}: flags with no MCP decision`).toEqual([]);
    for (const f of Object.keys(spec.omitted)) {
      expect(options.has(f), `${spec.path}: omitted ${f} is not a flag`).toBe(true);
      expect(mappedFlags.has(f), `${spec.path}: ${f} is both mapped and omitted`).toBe(false);
    }
    // Positionals: same order, arity and variadic-ness as the command's arguments.
    const positionals = Object.values(spec.params).filter((p) => p.positional === true);
    const args = cmd!.registeredArguments;
    expect(positionals.length, `${spec.path}: positional count`).toBe(args.length);
    args.forEach((a, i) => {
      const p = positionals[i]!;
      expect(a.variadic, `${spec.path} <${a.name()}> variadic`).toBe(REPEATABLE.has(p.kind));
      expect(a.required, `${spec.path} <${a.name()}> required`).toBe(p.required === true);
    });
  });
});

/**
 * The hand-written tools that mirror a command (#255 scope: run_journey, verify_fix,
 * queue_exploration): their MCP argument → the flag(s) it stands for, and the flags they omit, why.
 */
const NATIVE_FLAGS: Readonly<Record<string, { readonly path: string; readonly args: Readonly<Record<string, string>>; readonly omitted: Readonly<Record<string, string>> }>> = {
  run_journey: {
    path: "journey run",
    args: {
      id: "<id>",
      params: "--param",
      storageState: "--storage-state",
      env: "--env",
      baseUrl: "--base-url",
      headed: "--headed",
      slowMo: "--slow-mo",
      recordVideo: "--record-video",
      screenshots: "--screenshots",
      viewport: "--viewport",
      device: "--device",
      geolocation: "--geolocation",
      fixtures: "--fixtures",
      fixtureIdentity: "--fixture-identity",
      selfHeal: "--self-heal",
      changes: "--changes",
      changeNote: "--change-note",
      healMaxAttempts: "--heal-max-attempts",
      healMaxModelCalls: "--heal-max-model-calls",
      healMaxMs: "--heal-max-ms",
      healMaxRunAttempts: "--heal-max-run-attempts",
      healMaxRunMs: "--heal-max-run-ms",
      real: "--real",
      fakeAi: "--fake-ai",
      jevProvider: "--jev-provider",
      extension: "--extension",
      maxBrowsers: "--max-browsers",
      maxBrowserMemory: "--max-browser-memory",
      actionDeltas: "--action-deltas",
      tags: "--tag",
    },
    omitted: {
      "--ignore-host-load": OMIT.hostLoad,
      "--dir": OMIT.storeDir,
      "--json": OMIT.json,
      "--before": OMIT.hooks,
      "--after": OMIT.hooks,
      "--allow-shell-hooks": OMIT.hooks,
      "--hook-timeout-ms": OMIT.hooks,
      "--browser-executable": OMIT.browserBin,
      "--browser-channel": OMIT.browserBin,
      "--browser-arg": OMIT.browserBin,
    },
  },
  verify_fix: {
    path: "verify-fix",
    args: {
      fingerprint: "<fingerprint>",
      id: "--result",
      replays: "--replays",
      recordVideo: "--record-video",
      screenshots: "--screenshots",
      headed: "--headed",
      slowMo: "--slow-mo",
      storageState: "--storage-state",
      viewport: "--viewport",
      device: "--device",
      geolocation: "--geolocation",
      allowEmulationOverride: "--allow-emulation-override",
      invariants: "--invariants",
      fixtures: "--fixtures",
      fixtureIdentity: "--fixture-identity",
      extension: "--extension",
      maxBrowsers: "--max-browsers",
      maxBrowserMemory: "--max-browser-memory",
      actionDeltas: "--action-deltas",
      tags: "--tag",
    },
    omitted: {
      "--ignore-host-load": OMIT.hostLoad,
      "--fingerprint": "the positional's alias: MCP takes one 'fingerprint'",
      "--regressions-dir": "MCP names the finding by its result id (never a path); the ledger fallback is the ledger tool's `verify` action",
      "--param": OMIT.branchParams,
      "--allow-log-cmd": OMIT.logCmd,
      "--hang-replay-writes": OMIT.hangWrites,
      "--secret": OMIT.envSecret,
      "--json": OMIT.json,
      "--before": OMIT.hooks,
      "--after": OMIT.hooks,
      "--allow-shell-hooks": OMIT.hooks,
      "--hook-timeout-ms": OMIT.hooks,
      "--browser-executable": OMIT.browserBin,
      "--browser-channel": OMIT.browserBin,
      "--browser-arg": OMIT.browserBin,
    },
  },
  queue_exploration: {
    path: "mission queue",
    args: {
      target: "<target>",
      strategy: "--strategy",
      goal: "--goal",
      feature: "--feature",
      route: "--route",
      successAssertion: "--success",
      budget: "--max-actions --max-decisions --max-candidates",
      invariants: "--invariants",
      viewport: "--viewport",
      device: "--device",
      recordVideo: "--record-video",
      screenshots: "--screenshots",
      evidenceVideo: "--evidence-video",
      persona: "--persona",
      minEffort: "--min-actions --min-distinct-states",
    },
    omitted: { "--dir": OMIT.storeDir, "--targets-dir": OMIT.storeDir, "--json": OMIT.json },
  },
};

describe("#255: the extended hand-written tools cover their command's flags", () => {
  const served = new Map(buildMcpTools({ journeysDir: "/unused" }).map((t) => [t.name, t]));
  it.each(Object.entries(NATIVE_FLAGS))("%s", (tool, spec) => {
    const cmd = COMMANDS.get(spec.path)!;
    const props = Object.keys(served.get(tool)!.inputSchema.properties).sort();
    expect(props, `${tool}: its schema is exactly the mapped arguments`).toEqual(Object.keys(spec.args).sort());
    const covered = new Set(Object.values(spec.args).flatMap((f) => f.split(" ")).filter((f) => f.startsWith("--")));
    for (const f of covered) expect(cmd.options.some((o) => o.long === f), `${tool}: ${f} is not a flag of ${spec.path}`).toBe(true);
    const uncovered = cmd.options.map((o) => o.long ?? "").filter((f) => !covered.has(f) && spec.omitted[f] === undefined);
    expect(uncovered, `${tool}: flags of ${spec.path} with no MCP decision`).toEqual([]);
    for (const f of Object.keys(spec.omitted)) expect(cmd.options.some((o) => o.long === f), `${tool}: omitted ${f} is stale`).toBe(true);
  });
});

describe("#281: run_exploration's typeFixture confines each bound file like every MCP path", () => {
  it("passes '<descriptor>=<confined path>' and refuses a file outside the roots", async () => {
    const { buildCliArgv } = await import("./mcp-cli-tools.js");
    const spec = CLI_TOOL_SPECS.find((t) => t.name === "run_exploration")!;
    const root = process.cwd();
    const argv = buildCliArgv(spec, { url: "http://127.0.0.1:1/", typeFixture: ["label=Paste your text=fixtures/import.txt"] }, [root]);
    expect(argv).toContain(`--type-fixture=label=Paste your text=${root}/fixtures/import.txt`);
    expect(() => buildCliArgv(spec, { url: "http://127.0.0.1:1/", typeFixture: ["label=Body=/etc/passwd"] }, [root])).toThrow(/typeFixture\[0\]/);
    expect(() => buildCliArgv(spec, { url: "http://127.0.0.1:1/", typeFixture: ["no-file"] }, [root])).toThrow(/descriptor>=<file path>/);
  });
});
