import type { McpArgs } from "./mcp-args.js";

export type CliParamKind =
  /** `--flag=<value>` (or a positional). */
  | "string"
  /** A non-negative integer (`--flag=<n>`). */
  | "integer"
  /** A number (ratios, confidences). */
  | "number"
  /** `true` → `--flag`; `false`/absent → nothing. For a `--no-x` flag: `false` → `--no-x`. */
  | "boolean"
  /** A repeatable flag (`--flag=a --flag=b`) or a variadic positional. */
  | "string[]"
  /** `--param k=v` per entry (a string→string map). */
  | "params"
  /** A path the command reads (confined). */
  | "path"
  /** Repeatable read paths (confined). */
  | "path[]"
  /** A Playwright storage state (confined; never under a repo's `.jevitate/`). */
  | "session"
  /** `true` or a directory (confined) — `--record-video [dir]`-style optional values. */
  | "optional-path"
  /** `true` or a storage-state path (confined as a session) — `--save-storage-state [file]`. */
  | "optional-session"
  /** `--screenshots [mode|dir]` (any directory confined). */
  | "screenshots"
  /** `{width, height}` → `--viewport WxH`. */
  | "viewport"
  /** `name=<storageState>` entries (`--persona`/`--actor`): each path confined as a session. */
  | "named-sessions"
  /** `<descriptor>=<file>` entries (`--type-fixture`): the file (after the LAST `=`) confined as a read path. */
  | "bound-paths"
  /** #464: a path the command WRITES project output to — confined to the project roots only (never `~/.jevitate/`). */
  | "project-path";

export interface CliParam {
  readonly kind: CliParamKind;
  /** The long flag (`--env`); absent for a positional. */
  readonly flag?: string;
  /** A positional argument (in declaration order). */
  readonly positional?: true;
  readonly required?: true;
  /** A closed set of string values. */
  readonly enum?: readonly string[];
}

export interface CliCommandSpec {
  /** The commander path, e.g. `journey annotate`. */
  readonly path: string;
  readonly params: Readonly<Record<string, CliParam>>;
  /** Every flag of the command that is NOT an MCP argument, with why (checked by the parity guard). */
  readonly omitted: Readonly<Record<string, string>>;
  /**
   * The Journeys a `--param` of this command goes to, so a secret parameter's value is refused before
   * the command runs (secret-params.ts). Every command taking `--param` has one (checked by a guard).
   */
  readonly paramJourneys?: (args: McpArgs) => readonly unknown[];
}

export interface CliToolSpec {
  readonly name: string;
  readonly description: string;
  /** One command, or several selected by an `action` argument (a family of small commands). */
  readonly command?: CliCommandSpec;
  readonly actions?: Readonly<Record<string, CliCommandSpec>>;
  /** #787: this call only reads, and must answer while a long call of the same server holds the queue. */
  readonly answersWhileBusy?: (args: McpArgs) => boolean;
}

// ── Why a flag is not an MCP argument ──────────────────────────────────────────────────────────
export const OMIT = {
  json: "always set: the tool returns the command's JSON envelope",
  hooks: "operator shell hooks run commands on this machine: never model-chosen (--allow-shell-hooks is never set over MCP; an environment's hooks refuse as on the CLI without it)",
  browserBin: "which browser binary, channel and Chromium switches launch is the operator's setting (the server's own launch), never an MCP argument",
  storeDir: "store and results locations are the server's (the `jevitate mcp` defaults / --dir): an MCP argument never picks which directory is read or written as a store",
  envSecret: "binds an environment variable (or a literal secret) the run types or redacts: a request never chooses which of the operator's variables is read — secret fields come from targets.json (secretFields/personas)",
  mcpOrigins: "#484: a request adds no origin to a replay's allowlist by flag: over MCP use 'env' (an environment in environments.json), or verify-fix --allow on the CLI. Where a tool takes 'baseUrl', that argument can still name an origin the configuration doesn't know (docs/safety.md)",
  logCmd: "server-log sources can run commands and read arbitrary files: operator-declared only (targets.json logSources/allowLogCmd)",
  logTriage: "#313: sends the run's recorded log text (redacted) to the judgment model — an operator opt-in for their own logs, never a request's choice",
  hangWrites: "re-sending a paid/destructive write is the operator's call (targets.json safety.hangReplayWrites)",
  filingRepo: "where findings are filed (a GitHub repo, under the operator's identity) is the operator's filing config (~/.jevitate/filing.json)",
  watch: "a watch loop never returns: MCP drains once (call again to drain more)",
  branchParams:
    "#293: a branch-point finding replays through its Journey prefix with the params its result recorded (non-secret ones); a secret param is re-supplied by the operator on the CLI, never sent as an MCP argument",
  tou: "accepting a third-party source's Terms of Use is a person's decision (like approve_action): MCP can add, pull and run a source, never accept for them",
  acceptWeak: "#401: promoting a Journey whose assertions cannot prove its outcome is a reviewer's waiver (recorded on the Journey): a person's decision on the CLI, never a request's",
  reviewSheet: "#432: a review sheet FILE is what a person read on their screen; over MCP the same binding is the reviewedHash argument (the sheet's content hash from review_journey)",
  acceptFindings:
    "#433: approving despite pre-approval findings that need an acknowledgment (conflicts, broken links, …) is the approver's own judgment, recorded with the approval: a person's decision on the CLI (like --accept-weak), never a request's",
  catalogRendering: "#433/#435: review_persona / review_job / catalog_status / analyze_catalog return the schema-checked JSON; the Markdown/text renderings and writing them to a file are for people at the CLI",
  reviewRendering: "#432: review_journey returns the schema-checked JSON sheet; the Markdown/text renderings and writing them to a file are for people at the CLI",
  nonInteractiveApproval:
    "#437: the scripted-setup escape hatch for a CLI approval is the operator's choice, never a request's: an MCP approval needs no hatch — it is always recorded with provenance channel `mcp` (an agent's approval), which `check --require-approvals` fails unless the operator allows `mcp`",
  localDevCert: "#872: accepting a server's self-signed certificate narrows TLS validation for the run: the operator's launch setting (like the browser binary and switches), never an MCP argument",
  hostLoad: "#205: starting a browser run on a STARVED host (overriding E_HOST_STARVED) can take the machine other people's work runs on down with it: the operator's call, never a request's",
} as const;

export const HOOK_FLAGS = { "--before": OMIT.hooks, "--after": OMIT.hooks, "--allow-shell-hooks": OMIT.hooks, "--hook-timeout-ms": OMIT.hooks } as const;
export const BROWSER_FLAGS = { "--browser-executable": OMIT.browserBin, "--browser-channel": OMIT.browserBin, "--browser-arg": OMIT.browserBin, "--accept-local-dev-cert": OMIT.localDevCert, "--ignore-host-load": OMIT.hostLoad } as const;
export const JSON_FLAG = { "--json": OMIT.json } as const;
/** #585: --project / --journeys-dir pick a store, which over MCP is always the server's (as --dir). */
export const LOCATION_FLAGS = { "--project": OMIT.storeDir, "--journeys-dir": OMIT.storeDir } as const;

/** #426: `--tag key=value` → a `tags` object (`{"feature": "checkout"}`); keys/values validated by the command. */
export const TAGS: CliParam = { kind: "params", flag: "--tag" };

// ── Param helpers ─────────────────────────────────────────────────────────────────────────────
export const s = (flag: string, extra: Partial<CliParam> = {}): CliParam => ({ kind: "string", flag, ...extra });
export const n = (flag: string, extra: Partial<CliParam> = {}): CliParam => ({ kind: "integer", flag, ...extra });
export const num = (flag: string): CliParam => ({ kind: "number", flag });
export const b = (flag: string): CliParam => ({ kind: "boolean", flag });
export const many = (flag: string): CliParam => ({ kind: "string[]", flag });
export const path = (flag: string, extra: Partial<CliParam> = {}): CliParam => ({ kind: "path", flag, ...extra });
export const session = (flag: string): CliParam => ({ kind: "session", flag });
export const pos = (kind: CliParamKind = "string", extra: Partial<CliParam> = {}): CliParam => ({ kind, positional: true, required: true, ...extra });
export const EMULATION = { viewport: { kind: "viewport", flag: "--viewport" } as CliParam, device: s("--device"), geolocation: s("--geolocation") };
/** #256: unpacked browser extensions to load — confined like every path argument (a directory with manifest.json). */
export const EXTENSION = {
  extension: { kind: "path[]", flag: "--extension" } as CliParam,
  // #205: every browser-launching command also takes the run's resource limits (machine-wide browser
  // cap, browser memory ceiling in MiB) — spread with EXTENSION, which every such command already has.
  maxBrowsers: n("--max-browsers"),
  maxBrowserMemory: n("--max-browser-memory"),
};
export const DEMO_SHOW = { headed: b("--headed"), slowMo: n("--slow-mo") };
export const ENVIRONMENT = { env: s("--env"), baseUrl: s("--base-url") };
export const AI = { real: b("--real"), fakeAi: b("--fake-ai") };
/** #429: commands that build the live Jev gateway also take the Jev provider (typesafe | openrouter). */
export const JEV_AI = { ...AI, jevProvider: s("--jev-provider", { enum: ["typesafe", "openrouter"] }) };
/** #434/#435: the advisory Jev layer of a review sheet / approval / catalog analysis (judgment only, cached by content hash). */
export const JEV_ADVICE = { real: b("--real"), jevProvider: s("--jev-provider", { enum: ["typesafe", "openrouter"] }) };
/** #243: `name=<storageState>` identities a fixture step authenticates as — each path confined as a session. */
export const FIXTURE_IDENTITY: CliParam = { kind: "named-sessions", flag: "--fixture-identity" };
