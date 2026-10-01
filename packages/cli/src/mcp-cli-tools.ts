import { argErrorBody, McpArgError, optRecordVideo, optScreenshots, optViewport, type McpArgs } from "./mcp-args.js";
import { confineMcpPath } from "./mcp-paths.js";
import type { McpCliRunner } from "./mcp-cli-runner.js";

/**
 * #255 — MCP ⊇ CLI. Every CLI command an agent could run as `jevitate … --json` is reachable over
 * MCP (MCP is a convenience and an optimization for LLMs, not a separate product surface). The
 * tools here MIRROR a CLI command: their typed arguments map one-to-one onto that command's flags
 * and positional arguments, and the handler runs the command in process (mcp-cli-runner.ts) and
 * returns its JSON envelope and exit code. The CLI does every check it always does — so the two
 * surfaces validate, confine, redact and exit identically — and MCP adds its own strictness on top:
 *
 * - arguments are typed and closed: an unknown argument or a wrong type is `invalid_args`, never
 *   ignored or coerced;
 * - every path argument is confined (mcp-paths.ts): inside the project or `~/.jevitate/`, and a
 *   storage state never under a repo's `.jevitate/`;
 * - the argv is built by code, never parsed from caller text: options are passed as
 *   `--flag=value` and positionals after `--`, so no argument value can become a flag;
 * - flags that are the OPERATOR's call are not MCP arguments at all (`omitted`, each with its
 *   reason, checked against the real commander tree by mcp-cli-parity.test.ts): shell hooks, the
 *   browser binary/switches, which environment variable a secret is read from, `cmd:` log sources,
 *   store directories.
 *
 * Long-running commands follow the existing MCP pattern: a single browser run on one Journey,
 * finding or suite (run_journey, verify_fix, and here annotate/demo/check/regressions/load/…)
 * runs DIRECTLY and returns its verdict; open-ended exploration against a promoted target is
 * queue + poll (queue_exploration → run_queued_missions/`mission run` → get_mission_result). A
 * direct exploration (`explore`) is `run_exploration`, bounded by its own budget flags.
 *
 * The result: `{exitCode, data}` (the envelope's data). Exit 0/1/3/4 are answers (1 = defects /
 * still reproduces, 3 = hang, 4 = intermittent) and come back as a normal result; exit 2 (the run
 * proved nothing) and every refusal come back as an MCP error result — never a pass. A refusal is
 * `{error: "invalid_args" (exit 64) | "refused", code: "E_…", message, exitCode}`.
 */

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
  | "named-sessions";

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
}

export interface CliToolSpec {
  readonly name: string;
  readonly description: string;
  /** One command, or several selected by an `action` argument (a family of small commands). */
  readonly command?: CliCommandSpec;
  readonly actions?: Readonly<Record<string, CliCommandSpec>>;
}

// ── Why a flag is not an MCP argument ──────────────────────────────────────────────────────────
export const OMIT = {
  json: "always set: the tool returns the command's JSON envelope",
  hooks: "operator shell hooks run commands on this machine: never model-chosen (--allow-shell-hooks is never set over MCP; an environment's hooks refuse as on the CLI without it)",
  browserBin: "which browser binary, channel and Chromium switches launch is the operator's setting (the server's own launch), never an MCP argument",
  storeDir: "store and results locations are the server's (the `jevitate mcp` defaults / --dir): an MCP argument never picks which directory is read or written as a store",
  envSecret: "binds an environment variable (or a literal secret) the run types or redacts: a request never chooses which of the operator's variables is read — secret fields come from targets.json (secretFields/personas)",
  logCmd: "server-log sources can run commands and read arbitrary files: operator-declared only (targets.json logSources/allowLogCmd)",
  hangWrites: "re-sending a paid/destructive write is the operator's call (targets.json safety.hangReplayWrites)",
  filingRepo: "where findings are filed (a GitHub repo, under the operator's identity) is the operator's filing config (~/.jevitate/filing.json)",
  watch: "a watch loop never returns: MCP drains once (call again to drain more)",
  tou: "accepting a third-party source's Terms of Use is a person's decision (like approve_action): MCP can add, pull and run a source, never accept for them",
} as const;

const HOOK_FLAGS = { "--before": OMIT.hooks, "--after": OMIT.hooks, "--allow-shell-hooks": OMIT.hooks, "--hook-timeout-ms": OMIT.hooks } as const;
const BROWSER_FLAGS = { "--browser-executable": OMIT.browserBin, "--browser-channel": OMIT.browserBin, "--browser-arg": OMIT.browserBin } as const;
const JSON_FLAG = { "--json": OMIT.json } as const;

// ── Param helpers ─────────────────────────────────────────────────────────────────────────────
const s = (flag: string, extra: Partial<CliParam> = {}): CliParam => ({ kind: "string", flag, ...extra });
const n = (flag: string, extra: Partial<CliParam> = {}): CliParam => ({ kind: "integer", flag, ...extra });
const num = (flag: string): CliParam => ({ kind: "number", flag });
const b = (flag: string): CliParam => ({ kind: "boolean", flag });
const many = (flag: string): CliParam => ({ kind: "string[]", flag });
const path = (flag: string, extra: Partial<CliParam> = {}): CliParam => ({ kind: "path", flag, ...extra });
const session = (flag: string): CliParam => ({ kind: "session", flag });
const pos = (kind: CliParamKind = "string", extra: Partial<CliParam> = {}): CliParam => ({ kind, positional: true, required: true, ...extra });
const EMULATION = { viewport: { kind: "viewport", flag: "--viewport" } as CliParam, device: s("--device") };
/** #256: unpacked browser extensions to load — confined like every path argument (a directory with manifest.json). */
const EXTENSION = { extension: { kind: "path[]", flag: "--extension" } as CliParam };
const DEMO_SHOW = { headed: b("--headed"), slowMo: n("--slow-mo") };
const ENVIRONMENT = { env: s("--env"), baseUrl: s("--base-url") };
const AI = { real: b("--real"), fakeAi: b("--fake-ai") };

// ── The tools ─────────────────────────────────────────────────────────────────────────────────
export const CLI_TOOL_SPECS: readonly CliToolSpec[] = [
  {
    name: "list_journeys",
    description: "`jevitate journey list`: every Journey in the store (promoted and not) — id, name, promoted, params. find_capabilities is the promoted-only search.",
    command: { path: "journey list", params: {}, omitted: { "--dir": OMIT.storeDir, ...JSON_FLAG } },
  },
  {
    name: "promote_journey",
    description: "`jevitate journey promote <id>`: promote a local Journey so it becomes discoverable (find_capabilities) and runnable (run_journey).",
    command: { path: "journey promote", params: { id: pos() }, omitted: { "--dir": OMIT.storeDir, ...JSON_FLAG } },
  },
  {
    name: "annotate_journey",
    description:
      "`jevitate journey annotate <id>` (#246): replay the Journey and DRAFT each step's objective/expected result (and a missing goal/success criteria) into a reviewable draft — the Journey itself is never written. " +
      "With approve: true, applies the reviewed draft (shows the diff; refused with E_JOURNEY_ANNOTATIONS_STALE if the Journey changed since the draft) — the same proposal/approval semantics as the CLI. Drafting needs real or fakeAi.",
    command: {
      path: "journey annotate",
      params: { ...EXTENSION, id: pos(), approve: b("--approve"), params: { kind: "params", flag: "--param" }, storageState: session("--storage-state"), fixtures: path("--fixtures"), screenshots: { kind: "screenshots", flag: "--screenshots" }, ...ENVIRONMENT, ...EMULATION, ...AI },
      omitted: { "--dir": OMIT.storeDir, ...HOOK_FLAGS, ...BROWSER_FLAGS, ...JSON_FLAG },
    },
  },
  {
    name: "demo_journey",
    description:
      "`jevitate journey demo <id>` (#248): replay a Journey as a narrated demo — a WebM video with .vtt subtitles (video: a .webm path) and/or a Markdown step-by-step guide with screenshots (guide: a .md path). A Journey that no longer replays fails (exit 1). Paths inside the project or ~/.jevitate.",
    command: {
      path: "journey demo",
      params: {
        id: pos(),
        ...EXTENSION,
        video: path("--video"),
        guide: path("--guide"),
        pace: n("--pace"),
        params: { kind: "params", flag: "--param" },
        storageState: session("--storage-state"),
        fixtures: path("--fixtures"),
        screenshots: { kind: "screenshots", flag: "--screenshots" },
        ...ENVIRONMENT,
        ...EMULATION,
        ...DEMO_SHOW,
      },
      omitted: { "--dir": OMIT.storeDir, ...HOOK_FLAGS, ...BROWSER_FLAGS, ...JSON_FLAG },
    },
  },
  {
    name: "publish_journey",
    description: "`jevitate journey publish <id> --to <source>`: publish a promoted Journey into a registered source on a new publish/<id> branch (a PR when gh is available). Secret references only; declared origins must cover its steps.",
    command: {
      path: "journey publish",
      params: { id: pos(), to: s("--to", { required: true }), declareOrigin: many("--declare-origin"), as: s("--as") },
      omitted: { "--dir": OMIT.storeDir, ...JSON_FLAG },
    },
  },
  {
    name: "create_demo",
    description:
      "`jevitate demo \"<aspect>\"` / `demo create` (#249): explore a NAMED, non-production environment (env, required) toward the aspect, checked by success (required), minimize the path (verified by replay), annotate it and render a DRAFT demo (video, .vtt, guide). Nothing is promoted until approve_demo. Needs real or fakeAi.",
    command: {
      path: "demo create",
      params: { ...EXTENSION,
        aspect: pos(),
        env: s("--env"),
        success: s("--success"),
        persona: s("--persona"),
        id: s("--id"),
        start: s("--start"),
        maxActions: n("--max-actions"),
        maxDecisions: n("--max-decisions"),
        out: path("--out"),
        pace: n("--pace"),
        storageState: session("--storage-state"),
        fixtures: path("--fixtures"),
        ...EMULATION,
        ...DEMO_SHOW,
        ...AI,
      },
      omitted: { "--dir": OMIT.storeDir, ...HOOK_FLAGS, ...BROWSER_FLAGS, ...JSON_FLAG },
    },
  },
  {
    name: "approve_demo",
    description:
      "`jevitate demo approve <id>` (#249): approve a DRAFT demo — renders the final demo (no DRAFT marks) on the environment it was made on, then applies its annotations and promotes the Journey. A replay that no longer works promotes nothing (exit 1).",
    command: {
      path: "demo approve",
      params: { ...EXTENSION, id: pos(), out: path("--out"), pace: n("--pace"), storageState: session("--storage-state"), fixtures: path("--fixtures"), ...EMULATION, ...DEMO_SHOW },
      omitted: { "--dir": OMIT.storeDir, ...HOOK_FLAGS, ...BROWSER_FLAGS, ...JSON_FLAG },
    },
  },
  {
    name: "run_exploration",
    description:
      "`jevitate explore` run DIRECTLY (every strategy: goal (default) | coverage | exploratory | adversarial | usability, or feature): drives a real browser on url (which must be on an allow origin) within its budget, and returns the typed result (read later with get_mission_result by its result id). " +
      "For a PROMOTED target prefer queue_exploration (queue + poll). Model-driven strategies need real or fakeAi. Media: recordVideo, screenshots, evidenceVideo. Sessions: storageState, persona/actor entries 'name=<storageState path>'.",
    command: {
      path: "explore",
      params: { ...EXTENSION,
        url: s("--url"),
        allow: many("--allow"),
        strategy: s("--strategy", { enum: ["goal", "coverage", "exploratory", "adversarial", "usability"] }),
        goal: s("--goal"),
        success: many("--success"),
        successWhen: s("--success-when", { enum: ["final", "held"] }),
        allowVacuousChecks: b("--allow-vacuous-checks"),
        feature: s("--feature"),
        route: many("--route"),
        scope: s("--scope", { enum: ["app"] }),
        maxActions: n("--max-actions"),
        maxDecisions: n("--max-decisions"),
        stallTimeout: n("--stall-timeout"),
        invariants: { kind: "path[]", flag: "--invariants" },
        storageState: session("--storage-state"),
        saveStorageState: session("--save-storage-state"),
        persona: { kind: "named-sessions", flag: "--persona" },
        personas: path("--personas"),
        actor: { kind: "named-sessions", flag: "--actor" },
        fixtures: path("--fixtures"),
        fixture: path("--fixture"),
        appClass: s("--app-class"),
        show: s("--show"),
        minConfidence: num("--min-confidence"),
        maxFindingsPerPage: n("--max-findings-per-page"),
        product: path("--product"),
        polish: b("--polish"),
        repeat: n("--repeat"),
        minAgreement: n("--min-agreement"),
        allowDestructive: b("--allow-destructive"),
        allowWrites: b("--allow-writes"),
        allowWrite: many("--allow-write"),
        deny: many("--deny"),
        paid: many("--paid"),
        readRpc: many("--read-rpc"),
        settleIgnore: many("--settle-ignore"),
        ignoreNoProgress: many("--ignore-no-progress"),
        ignoreOverflow: many("--ignore-overflow"),
        checkOverflow: b("--check-overflow"),
        apiPrefix: many("--api-prefix"),
        longPollMs: n("--long-poll-ms"),
        jobWaitMs: n("--job-wait-ms"),
        replyWaitMs: n("--reply-wait-ms"),
        replyCeilingMs: n("--reply-ceiling-ms"),
        replyMaxChars: n("--reply-max-chars"),
        hangReplays: n("--hang-replays"),
        minControlCoverage: num("--min-control-coverage"),
        requireFormSubmit: b("--no-require-form-submit"),
        fileIssues: b("--file-issues"),
        out: path("--out"),
        recordVideo: { kind: "optional-path", flag: "--record-video" },
        screenshots: { kind: "screenshots", flag: "--screenshots" },
        evidenceVideo: b("--evidence-video"),
        overlay: b("--no-overlay"),
        ...EMULATION,
        ...DEMO_SHOW,
        ...AI,
      },
      omitted: {
        ...HOOK_FLAGS,
        ...BROWSER_FLAGS,
        ...JSON_FLAG,
        "--secret": OMIT.envSecret,
        "--secret-field": OMIT.envSecret,
        "--totp": OMIT.envSecret,
        "--allow-log-cmd": OMIT.logCmd,
        "--log-source": OMIT.logCmd,
        "--log-defect": OMIT.logCmd,
        "--log-ignore": OMIT.logCmd,
        "--log-scope": OMIT.logCmd,
        "--log-correlation-header": OMIT.logCmd,
        "--log-id-pattern": OMIT.logCmd,
        "--log-quiet-ok": OMIT.logCmd,
        "--server-log-drain-ms": OMIT.logCmd,
        "--hang-replay-writes": OMIT.hangWrites,
        "--issue-repo": OMIT.filingRepo,
        "--jevitate-repo": OMIT.filingRepo,
      },
    },
  },
  {
    name: "author_journey",
    description:
      "`jevitate explore-author-journey`: explore url toward goal (checked by success) several takes, and author an UNPROMOTED Journey from the verified path (promote_journey makes it runnable). Needs real or fakeAi.",
    command: {
      path: "explore-author-journey",
      params: { ...EXTENSION,
        url: s("--url"),
        goal: s("--goal"),
        success: s("--success"),
        allow: many("--allow"),
        id: s("--id"),
        name: s("--name"),
        takes: n("--takes"),
        maxActions: n("--max-actions"),
        maxDecisions: n("--max-decisions"),
        storageState: session("--storage-state"),
        ...AI,
      },
      omitted: { "--journeys-dir": OMIT.storeDir, ...BROWSER_FLAGS, ...JSON_FLAG },
    },
  },
  {
    name: "run_check",
    description:
      "`jevitate check --suite <file>`: the CI regression gate — a suite of Journeys, invariants, goals and missions within a budget; writes JUnit + SARIF + JSON under out. Exit 1 = a gating finding.",
    command: {
      path: "check",
      params: { ...EXTENSION,
        suite: path("--suite", { required: true }),
        out: path("--out"),
        jsonOut: path("--json-out"),
        junit: path("--junit"),
        sarif: path("--sarif"),
        baseline: s("--baseline"),
        changedRoutes: many("--changed-routes"),
        targetBuild: s("--target-build"),
        ...AI,
      },
      omitted: { "--baseline-dir": OMIT.storeDir, ...BROWSER_FLAGS, ...JSON_FLAG },
    },
  },
  {
    name: "get_report",
    description: "`jevitate report`: one deduped defect list for a target across every mode and run (+ an optional diff section against a baseline run, tag or `last`).",
    command: {
      path: "report",
      params: { target: s("--target"), since: s("--since"), baseline: s("--baseline"), out: path("--out") },
      omitted: { "--dir": OMIT.storeDir, ...JSON_FLAG },
    },
  },
  {
    name: "diff_runs",
    description: "`jevitate diff <runA> <runB>`: classify findings new / resolved / still-present / flaky / not-rerun between two runs (runA = baseline).",
    command: { path: "diff", params: { runA: pos(), runB: pos() }, omitted: { "--dir": OMIT.storeDir, ...JSON_FLAG } },
  },
  {
    name: "baselines",
    description: "`jevitate baseline list | show <name> | tag <name> <runs…>`: named baselines for report/check/diff.",
    actions: {
      list: { path: "baseline list", params: {}, omitted: JSON_FLAG },
      show: { path: "baseline show", params: { name: pos() }, omitted: JSON_FLAG },
      tag: { path: "baseline tag", params: { name: pos(), runs: pos("string[]") }, omitted: { "--dir": OMIT.storeDir, ...JSON_FLAG } },
    },
  },
  {
    name: "ledger",
    description:
      "`jevitate ledger add <result> <fingerprint> | list | verify [fingerprints…]`: the repro ledger verify_fix falls back to, kept by fingerprint. verify replays entries (replays, storageState).",
    actions: {
      add: { path: "ledger add", params: { result: pos("path"), fingerprint: pos(), ticket: s("--ticket") }, omitted: { "--dir": OMIT.storeDir, "--secret": OMIT.envSecret, ...JSON_FLAG } },
      list: { path: "ledger list", params: {}, omitted: { "--dir": OMIT.storeDir, ...JSON_FLAG } },
      verify: {
        path: "ledger verify",
        params: { ...EXTENSION, fingerprints: { kind: "string[]", positional: true }, ticket: s("--ticket"), replays: n("--replays"), storageState: session("--storage-state") },
        omitted: { "--dir": OMIT.storeDir, "--allow-log-cmd": OMIT.logCmd, ...BROWSER_FLAGS, ...JSON_FLAG },
      },
    },
  },
  {
    name: "run_load_test",
    description: "`jevitate load run <journeyId>`: replay a Journey concurrently (concurrency × iterations) against an authorized origin and report latency/errors.",
    command: {
      path: "load run",
      params: {
        journeyId: pos(),
        ...EXTENSION,
        authorizedOrigin: many("--authorized-origin"),
        concurrency: n("--concurrency"),
        iterations: n("--iterations"),
        seed: n("--seed"),
        params: { kind: "params", flag: "--param" },
        storageState: session("--storage-state"),
        ...ENVIRONMENT,
        ...EMULATION,
      },
      omitted: { "--dir": OMIT.storeDir, ...BROWSER_FLAGS, ...JSON_FLAG },
    },
  },
  {
    name: "prune_logs",
    description: "`jevitate logs prune`: prune run output under .jevitate/logs by the retention policy (dryRun: report only).",
    command: { path: "logs prune", params: { dryRun: b("--dry-run") }, omitted: { "--dir": OMIT.storeDir, ...JSON_FLAG } },
  },
  {
    name: "run_queued_missions",
    description:
      "`jevitate mission run --once`: drain the missions queue_exploration queued (each through its strategy's runner; results where get_mission_result reads them), then return the drain report. Model-driven missions need real or fakeAi (others stay queued, reported as skipped).",
    command: {
      path: "mission run",
      params: { ...EXTENSION, ...AI },
      omitted: {
        "--once": "the default: MCP drains what is queued once and returns",
        "--watch": OMIT.watch,
        "--interval": OMIT.watch,
        "--dir": OMIT.storeDir,
        "--targets-dir": OMIT.storeDir,
        "--out": OMIT.storeDir,
        ...BROWSER_FLAGS,
        ...JSON_FLAG,
      },
    },
  },
  {
    name: "mission_targets",
    description:
      "`jevitate mission target add | list | update | promote`: the targets queue_exploration may enqueue against (only PROMOTED ones). add/update may set the target's session (storageState / saveStorageState paths); which environment variables a target's secret fields read is the operator's (`--secret-field` on the CLI, or targets.json), never an MCP argument.",
    actions: {
      add: {
        path: "mission target add",
        params: {
          id: pos(),
          name: s("--name"),
          description: s("--description"),
          authorizedOrigin: s("--authorized-origin"),
          apiOrigin: many("--api-origin"),
          baseUrl: s("--base-url"),
          storageState: session("--storage-state"),
          saveStorageState: { kind: "optional-session", flag: "--save-storage-state" },
        },
        omitted: { "--dir": OMIT.storeDir, "--secret-field": OMIT.envSecret, ...JSON_FLAG },
      },
      list: { path: "mission target list", params: {}, omitted: { "--dir": OMIT.storeDir, ...JSON_FLAG } },
      update: {
        path: "mission target update",
        params: { id: pos(), storageState: session("--storage-state"), saveStorageState: { kind: "optional-session", flag: "--save-storage-state" }, clearAuth: b("--clear-auth") },
        omitted: { "--dir": OMIT.storeDir, "--secret-field": OMIT.envSecret, ...JSON_FLAG },
      },
      promote: { path: "mission target promote", params: { id: pos() }, omitted: { "--dir": OMIT.storeDir, ...JSON_FLAG } },
    },
  },
  {
    name: "profiles",
    description: "`jevitate profile create <name> | status <name>`: isolated credential/data profiles.",
    actions: {
      create: { path: "profile create", params: { name: pos() }, omitted: JSON_FLAG },
      status: { path: "profile status", params: { name: pos() }, omitted: JSON_FLAG },
    },
  },
  {
    name: "recordings",
    description: "`jevitate recording diff | fit | postdoc | promote`: compare takes, fit a Recording, post-document takes, promote a literal to a variable.",
    actions: {
      diff: { path: "recording diff", params: { takeA: pos("path"), takeB: pos("path"), more: { kind: "path[]", positional: true } }, omitted: JSON_FLAG },
      fit: { path: "recording fit", params: { file: pos("path") }, omitted: JSON_FLAG },
      postdoc: { path: "recording postdoc", params: { take: pos("path"), more: { kind: "path[]", positional: true }, decisions: path("--decisions"), out: path("--out") }, omitted: JSON_FLAG },
      // No --json flag: it prints the promoted Recording as JSON (refusals are envelopes).
      promote: {
        path: "recording promote",
        params: { file: pos("path"), page: n("--page", { required: true }), step: n("--step", { required: true }), var: s("--var", { required: true }) },
        omitted: {},
      },
    },
  },
  {
    name: "regressions",
    description:
      "`jevitate regression capture | run`: capture a finding as a committed regression (from a Recording/result, verified by attempts) and replay one by id (exit 1 = it regressed).",
    actions: {
      capture: {
        path: "regression capture",
        params: { ...EXTENSION,
          from: path("--from", { required: true }),
          id: s("--id", { required: true }),
          result: path("--result"),
          fingerprint: s("--fingerprint"),
          summary: s("--summary"),
          attempts: n("--attempts"),
          force: b("--force"),
          storageState: session("--storage-state"),
          fixtures: path("--fixtures"),
          ...EMULATION,
          ...DEMO_SHOW,
        },
        omitted: { "--dir": OMIT.storeDir, ...HOOK_FLAGS, ...BROWSER_FLAGS, ...JSON_FLAG },
      },
      run: {
        path: "regression run",
        params: { ...EXTENSION, id: pos(), attempts: n("--attempts"), storageState: session("--storage-state"), ...ENVIRONMENT, ...EMULATION, ...DEMO_SHOW },
        omitted: { "--dir": OMIT.storeDir, ...BROWSER_FLAGS, ...JSON_FLAG },
      },
    },
  },
  {
    name: "site_policy",
    description: "`jevitate site policy get | set` and `site simulate`: per-origin pacing, throttles, budgets and quiet hours (run_journey honours them).",
    actions: {
      get: { path: "site policy get", params: { site: pos(), account: s("--account") }, omitted: { "--db": OMIT.storeDir, ...JSON_FLAG } },
      set: { path: "site policy set", params: { site: pos(), file: path("--file", { required: true }), account: s("--account") }, omitted: { "--db": OMIT.storeDir, ...JSON_FLAG } },
      simulate: { path: "site simulate", params: { site: pos(), script: path("--script", { required: true }), seed: n("--seed"), account: s("--account") }, omitted: { "--db": OMIT.storeDir, ...JSON_FLAG } },
    },
  },
  {
    name: "sources",
    description:
      "`jevitate source add | list | pull | update | remove | run`: distributed Journey sources (git). A source's Terms of Use and per-Journey trust are a person's decisions (`source add --accept-tou`, `source trust` on the CLI); run refuses an untrusted Journey.",
    actions: {
      add: { path: "source add", params: { name: pos(), gitUrl: pos() }, omitted: { "--accept-tou": OMIT.tou, ...JSON_FLAG } },
      list: { path: "source list", params: {}, omitted: JSON_FLAG },
      pull: { path: "source pull", params: { name: pos() }, omitted: JSON_FLAG },
      update: { path: "source update", params: { name: pos() }, omitted: JSON_FLAG },
      remove: { path: "source remove", params: { name: pos() }, omitted: JSON_FLAG },
      run: {
        path: "source run",
        params: { ...EXTENSION, name: pos(), journeyId: pos(), params: { kind: "params", flag: "--param" }, storageState: session("--storage-state"), ...EMULATION },
        omitted: { ...BROWSER_FLAGS, ...JSON_FLAG },
      },
    },
  },
  {
    name: "ux_review",
    description: "`jevitate ux <recording>`: offline UX review of a saved Recording — ranked, cited usability findings (appClass required). Needs real or fakeAi.",
    command: {
      path: "ux",
      params: {
        recording: pos("path"),
        appClass: s("--app-class"),
        job: s("--job"),
        persona: s("--persona"),
        evidence: path("--evidence"),
        result: path("--result"),
        out: path("--out"),
        show: s("--show"),
        minConfidence: num("--min-confidence"),
        maxFindingsPerPage: n("--max-findings-per-page"),
        product: path("--product"),
        polish: b("--polish"),
        ...AI,
      },
      omitted: JSON_FLAG,
    },
  },
  {
    name: "validate_invariants",
    description: "`jevitate invariants validate <files…>`: validate app-declared invariant files (optionally against a url / allow origins / observer actors) without running anything.",
    command: {
      path: "invariants validate",
      params: { files: pos("path[]"), url: s("--url"), allow: many("--allow"), observer: many("--observer") },
      omitted: JSON_FLAG,
    },
  },
  {
    name: "get_ai_status",
    description:
      "`jevitate ai status`: which model-gateway credentials each AI feature uses, where each comes from (env or the stored file) and whether its provider accepts it (a live auth check; `verify: false` skips it) — names, sources and verdicts only, never a key value.",
    command: { path: "ai status", params: { verify: b("--no-verify") }, omitted: JSON_FLAG },
  },
];

// ── Schema + argv ─────────────────────────────────────────────────────────────────────────────
function paramSchema(p: CliParam): Record<string, unknown> {
  switch (p.kind) {
    case "string":
      return p.enum === undefined ? { type: "string" } : { type: "string", enum: [...p.enum] };
    case "integer":
      return { type: "integer", minimum: 0 };
    case "number":
      return { type: "number" };
    case "boolean":
      return { type: "boolean" };
    case "string[]":
    case "path[]":
    case "named-sessions":
      return { type: "array", items: { type: "string" } };
    case "params":
      return { type: "object", additionalProperties: { type: "string" } };
    case "path":
    case "session":
      return { type: "string" };
    case "optional-path":
    case "optional-session":
    case "screenshots":
      return { type: ["boolean", "string"] };
    case "viewport":
      return { type: "object", properties: { width: { type: "integer" }, height: { type: "integer" } }, required: ["width", "height"] };
  }
}

/** The MCP inputSchema for a CLI-backed tool (a family adds the `action` discriminator). */
export function cliToolInputSchema(spec: CliToolSpec): { type: "object"; properties: Record<string, unknown>; required?: string[]; additionalProperties: false } {
  const commands = spec.command !== undefined ? [spec.command] : Object.values(spec.actions ?? {});
  const properties: Record<string, unknown> = {};
  for (const c of commands) for (const [name, p] of Object.entries(c.params)) properties[name] = paramSchema(p);
  if (spec.actions !== undefined) properties.action = { type: "string", enum: Object.keys(spec.actions) };
  const required =
    spec.actions !== undefined
      ? ["action"]
      : Object.entries(spec.command!.params)
          .filter(([, p]) => p.required === true)
          .map(([k]) => k);
  return { type: "object", properties, ...(required.length === 0 ? {} : { required }), additionalProperties: false };
}

/** The command an invocation selects (validating `action` for a family). */
export function commandFor(spec: CliToolSpec, args: McpArgs): CliCommandSpec {
  if (spec.command !== undefined) return spec.command;
  const actions = spec.actions ?? {};
  const action = args.action;
  if (typeof action !== "string" || actions[action] === undefined) throw new McpArgError(`'action' must be one of ${Object.keys(actions).join(" | ")}`);
  return actions[action];
}

const asText = (v: unknown, key: string): string => {
  if (typeof v !== "string" || v.length === 0) throw new McpArgError(`'${key}' must be a non-empty string`);
  if (v.includes("\0")) throw new McpArgError(`'${key}' must not contain a NUL byte`);
  return v;
};

const asStrings = (v: unknown, key: string): string[] => {
  if (!Array.isArray(v)) throw new McpArgError(`'${key}' must be an array of strings`);
  return v.map((x, i) => asText(x, `${key}[${i}]`));
};

/** The values one argument contributes (before flag formatting). */
function values(name: string, p: CliParam, v: unknown, roots: readonly string[]): string[] | boolean {
  switch (p.kind) {
    case "string": {
      const t = asText(v, name);
      if (p.enum !== undefined && !p.enum.includes(t)) throw new McpArgError(`'${name}' must be one of ${p.enum.join(" | ")}`);
      return [t];
    }
    case "integer":
      if (typeof v !== "number" || !Number.isInteger(v) || v < 0) throw new McpArgError(`'${name}' must be a non-negative integer`);
      return [String(v)];
    case "number":
      if (typeof v !== "number" || !Number.isFinite(v)) throw new McpArgError(`'${name}' must be a number`);
      return [String(v)];
    case "boolean":
      if (typeof v !== "boolean") throw new McpArgError(`'${name}' must be a boolean`);
      return v;
    case "string[]":
      return asStrings(v, name);
    case "path":
      return [confineMcpPath(v, name, roots)];
    case "session":
      return [confineMcpPath(v, name, roots, { session: true })];
    case "path[]":
      return asStrings(v, name).map((x, i) => confineMcpPath(x, `${name}[${i}]`, roots));
    case "named-sessions":
      return asStrings(v, name).map((x, i) => {
        const eq = x.indexOf("=");
        if (eq <= 0) throw new McpArgError(`'${name}[${i}]' must be 'name=<storageState path>'`);
        return `${x.slice(0, eq)}=${confineMcpPath(x.slice(eq + 1), `${name}[${i}]`, roots, { session: true })}`;
      });
    case "params": {
      if (v === null || typeof v !== "object" || Array.isArray(v)) throw new McpArgError(`'${name}' must be an object of string values`);
      return Object.entries(v as Record<string, unknown>).map(([k, x]) => {
        if (k.length === 0 || k.includes("=")) throw new McpArgError(`'${name}' keys must be non-empty and contain no '='`);
        return `${k}=${asText(x, `${name}.${k}`)}`;
      });
    }
    case "optional-path": {
      const r = optRecordVideo({ [name]: v }, roots, name);
      return typeof r === "string" ? [r] : r === true;
    }
    case "optional-session":
      if (v === false) return false;
      if (v === true) return true;
      return [confineMcpPath(v, name, roots, { session: true })];
    case "screenshots": {
      const r = optScreenshots({ [name]: v }, roots, name);
      return typeof r === "string" ? [r] : r === true;
    }
    case "viewport":
      return [optViewport({ [name]: v }, name)!];
  }
}

/**
 * The argv for one invocation: `<path…> --flag=value… --json -- <positionals…>`. Options use the
 * `=` form and positionals follow `--`, so no value can ever be read as a flag.
 */
export function buildCliArgv(spec: CliToolSpec, args: McpArgs, roots: readonly string[]): string[] {
  const command = commandFor(spec, args);
  const known = new Set([...Object.keys(command.params), ...(spec.actions === undefined ? [] : ["action"])]);
  const unknown = Object.keys(args).filter((k) => !known.has(k));
  if (unknown.length > 0) {
    throw new McpArgError(`unknown argument(s) for ${spec.name}${spec.actions === undefined ? "" : ` ${String(args.action)}`}: ${unknown.join(", ")} (allowed: ${[...known].join(", ") || "none"})`);
  }
  const flags: string[] = [];
  const positionals: string[] = [];
  for (const [name, p] of Object.entries(command.params)) {
    const v = args[name];
    if (v === undefined) {
      if (p.required === true) throw new McpArgError(`'${name}' is required`);
      continue;
    }
    const out = values(name, p, v, roots);
    if (p.positional === true) {
      if (typeof out === "boolean") throw new McpArgError(`'${name}' must be a value`);
      positionals.push(...out);
      continue;
    }
    const flag = p.flag!;
    if (typeof out === "boolean") {
      // `--no-x` flags are exposed as `x: false`; everything else as `x: true`.
      const negated = flag.startsWith("--no-");
      if (out === !negated) flags.push(flag);
      continue;
    }
    for (const value of out) flags.push(`${flag}=${value}`);
  }
  // `--json` whenever the command has it (every one but `recording promote`, which prints JSON anyway).
  return [...command.path.split(" "), ...flags, ...(command.omitted["--json"] === undefined ? [] : ["--json"]), "--", ...positionals];
}

export interface CliToolOutcome {
  readonly isError: boolean;
  readonly body: Record<string, unknown>;
}

/** The last `{v, ok}` envelope line the command printed. */
function lastEnvelope(stdout: string): { ok: boolean; data?: unknown; error?: { code?: string; message?: string } } | undefined {
  const lines = stdout.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("{"));
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const o = JSON.parse(lines[i]!) as Record<string, unknown>;
      if (typeof o.ok === "boolean" && "v" in o) return o as { ok: boolean; data?: unknown; error?: { code?: string; message?: string } };
    } catch {
      // not an envelope line
    }
  }
  return undefined;
}

/**
 * Runs one CLI-backed tool call: argv from the typed arguments, the CLI in process, its envelope back.
 * `redact` strips credential values from the output text (belt-and-braces over the CLI's own redaction).
 */
export async function runCliTool(spec: CliToolSpec, args: McpArgs, deps: { runCli?: McpCliRunner; roots: readonly string[]; redact: (text: string) => string }): Promise<CliToolOutcome> {
  let argv: string[];
  try {
    argv = buildCliArgv(spec, args, deps.roots);
  } catch (err) {
    const body = argErrorBody(err);
    if (body === undefined) throw err;
    return { isError: true, body };
  }
  if (deps.runCli === undefined) {
    return { isError: true, body: { error: "not_configured", message: `${spec.name} runs \`jevitate ${commandFor(spec, args).path}\` in process, which this server was not given` } };
  }
  const { stdout: raw, exitCode } = await deps.runCli(argv);
  const stdout = deps.redact(raw);
  let envelope = lastEnvelope(stdout);
  if (envelope === undefined && exitCode === 0) {
    // A command without --json (`recording promote`) prints its result as plain JSON.
    try {
      envelope = { ok: true, data: JSON.parse(stdout) as unknown };
    } catch {
      envelope = undefined;
    }
  }
  if (envelope === undefined) return { isError: true, body: { error: "internal", message: "the command printed no JSON envelope", exitCode } };
  if (!envelope.ok) {
    return { isError: true, body: { error: exitCode === 64 ? "invalid_args" : "refused", code: envelope.error?.code ?? "E_UNKNOWN", message: envelope.error?.message ?? "refused", exitCode } };
  }
  // 0/1/3/4 are answers; 2 (proved nothing) is never a pass.
  return { isError: exitCode === 2 || exitCode >= 64, body: { exitCode, data: envelope.data ?? null } };
}
