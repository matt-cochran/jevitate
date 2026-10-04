import { existsSync } from "node:fs";
import { Command } from "commander";
import { type InvariantSpec } from "@jevitate/recording";
import { envCredentialStore, MissingCredentialError, UsageTracker, type JudgmentPort, type GenerationPort } from "@jevitate/ai-core";
import { loadLocalCredentials } from "./credentials-file.js";
import {
  FixtureNotFoundError,
  ScopeUnderivableError,
  UnauthorizedExploreTargetError,
  resolveCoverageThresholds,
  parseSecretField,
  SecretFieldSpecError,
  TypeFixtureSpecError,
  validateDenyPatterns,
  type CoverageThresholds,
  type DialogPolicy,
  type SecretField,
  type SuccessCheck,
  type TypeFixture,
} from "@jevitate/explore";
import { loadTypeFixtures } from "./type-fixture-file.js";
import { ok, fail, type JsonEnvelope } from "./envelope.js";
import { SessionFileInProjectError, assertSessionFileOutsideProject } from "./project-dir.js";
import { InvariantsFileError, loadInvariantFiles, resolveInvariantAuthTokens } from "./invariants-file.js";
import { FilingConfigError, loadFilingFileConfig, resolveFilingConfig } from "./findings-filing.js";
import { fileDraftsWithEvidence } from "./defect-evidence.js";
import { parseScreenshotsArg, type ScreenshotsSpec } from "./run-screenshots.js";
import { GitHubIssueFiler } from "./github-issue-filer.js";
import { TargetConfigError, loadTargetsFile, resolveTargetConfig, type TargetConfig } from "./target-config.js";
import {
  buildMissionFixtures,
  checkSetupRefs,
  checkUrlRefOrigin,
  substituteUrlSetupRefs,
  setupRefFreeUrl,
  invariantSetupTexts,
  substituteSpecSetupRefs,
  fixtureSetupFailedResult,
  withFixtureFlags,
  type FixtureFlags,
} from "./fixture-cli.js";
import {
  FixtureSetupError,
  FixtureSpecError,
  UnboundSetupRefError,
  substituteSetupRefs,
  type MissionFixtures,
} from "./mission-fixtures.js";
import type { FilingConfig, IssueFilerPort } from "@jevitate/domain";
import { LITERAL_SECRET_WARNING, SecretArgError, resolveSecretArgs } from "./secret-args.js";
import { withEngine } from "./engine.js";
import { setKillSwitchOutput } from "./kill-signal.js";
import { EXIT_CODES } from "./exit-codes.js";
import { intArg, positiveNumberArg, nonNegativeIntArg, positiveIntArg, ratioArg } from "./cli-args.js";
import { formatMissionHuman, formatMultiRunHuman } from "./cli-output.js";
import {
  runExploration,
  runCoverageMission,
  runAdversarialCliMission,
  CLI_ADVERSARIAL_STRATEGIES,
  runFeatureCliMission,
  parseSuccessSpec,
  resolveExploreAllowlist,
  type ServerLogOptions,
} from "./explore-api.js";
import { parseLogSourceSpecs, LogSourceSpecError } from "./log-sources.js";
import { triagedServerLog } from "./explore-shared.js";
import { parseLogDefectSpecs, parseLogIgnoreSpecs, parseLogScopeSpecs } from "./log-correlation.js";
import { parseCorrelationHeaders, parseLogIdPatterns } from "./log-trace.js";
import { LogSpecError } from "./log-lines.js";
import { MultiRunArgsError, resolveMultiRunPlan, wantsMultiRun } from "./multi-run.js";
import { MultiRunAbortedError, runExploreMultiRun } from "./multi-run-cli.js";
import { checkActorsAgainstSpec, resolveMissionActors, type MissionActors } from "./mission-actors.js";
import { runUsabilityMission, UsabilityInvariantsUnsupportedError } from "./ux-api.js";
import { UxConfigError } from "./ux-config.js";
import { MinConfidenceError, QualityPolicyError, MaxFindingsPerRouteError, ProductFactsError } from "@jevitate/ux";
import { type EmulationSpec } from "@jevitate/playwright";
import {
  type CliDeps,
  type BrowserLaunchFlags,
  type DemoFlags,
  withBrowserLaunchFlags,
  withDemoFlags,
  withScreenshotsFlag,
  type ScreenshotsFlags,
  browserRunFromFlags,
  type EmulationFlags,
  withEmulationFlags,
  emulationFromFlags,
  emitCommandResult,
  collectParam,
  environmentSeams,
  resolveDbPath,
  resolveJourneysDir,
  resolveMissionTargetsDir,
  stallTimeoutMs,
  EXPLORE_STRATEGIES,
  EXPLORE_OUTCOME_HELP,
  GatewaySelectionError,
  buildExploreGateways,
} from "./cli-shared.js";
import { allowWithExtensions, assertExtensionTargetLoaded, multiWindowWarning } from "./browser-run-options.js";
import { ParamValidationError } from "@jevitate/journey";
import { SiteGateRefusedError } from "@jevitate/runtime";
import { JourneyRequiresAuthError, UnknownJourneyError } from "./journey-api.js";
import { environmentFromFlags, isEnvironmentError, withEnvironmentFlags, type EnvironmentFlags } from "./environments.js";
import { resolve as resolvePath } from "node:path";
import { CAMPAIGN_LIMITS, isSweepMode } from "@jevitate/journey";
import { CampaignSpecError, runCampaign, validateCampaignSpec } from "./campaign-api.js";
import { formatCampaignHuman } from "./campaign-cli.js";
import { forwardedArgv } from "./multi-run-cli.js";
import {
  ANCHORED_STRATEGIES,
  JourneyPrefixArgsError,
  JourneyPrefixStaleError,
  journeyStaleResult,
  resolveJourneyPrefix,
  type JourneyPrefix,
} from "./journey-prefix.js";
import { clock } from "@jevitate/domain";

/**
 * #293: the flags a sweep sets on each of its missions itself (the rest of the command line is
 * forwarded to every mission as given).
 */
const SWEEP_OWNED: ReadonlySet<string> = new Set([
  "fromJourney", "atStep", "strategy", "journeysDir", "param", "env", "baseUrl", "storageState", "maxActions", "maxDecisions",
  "goal", "success", "appClass", "real", "fakeAi", "fixtures", "before", "after", "allowShellHooks", "hookTimeoutMs",
]);

/**
 * Registers `jevitate explore` (every strategy: goal, coverage, exploratory, adversarial, usability, feature, multi-run).
 * `buildProgram` builds a fresh program for each run of a multi-run (#141/#143).
 */
export function registerExploreCommands(program: Command, deps: CliDeps, buildProgram: (deps: CliDeps) => Command): void {
  withEnvironmentFlags(withScreenshotsFlag(withEmulationFlags(
    withFixtureFlags(
      withDemoFlags(
        withBrowserLaunchFlags(
          program
            .command("explore")
            .description("goal-directed exploration -> a deterministic Recording (authoring/test plane)"),
        ),
        { recordVideo: true, overlay: true },
      ),
    ),
  )))
    .option("--url <url>", "target URL (must be an authorized origin)")
    .option(
      "--from-journey <id>",
      "journey-anchored exploration (#293): start from a PROMOTED Journey instead of --url — its first --at-step steps are replayed " +
        "in the mission's own browser context (page, form contents and session kept; fail-closed, never self-healed; --env/--base-url apply), " +
        "then the mission starts on the live page. A replay that stops before the anchor ends the run inconclusive (failure.kind journey-stale, exit 2). " +
        "Strategies: goal, coverage, exploratory, adversarial, usability",
    )
    .option(
      "--at-step <n|name|all|anchors>",
      "with --from-journey: the step to branch off — a 1-based top-level step number or an anchor name (`jevitate journey anchors <id>`); " +
        "`all` sweeps every step and `anchors` every anchor: each a fresh session (restored by --fixtures), --max-actions/--max-decisions split evenly per stop, one deduped report",
    )
    .option("--param <kv>", "with --from-journey: a Journey param as key=value (repeatable); only the prefix's own params are required", collectParam, {} as Record<string, string>)
    .option("--journeys-dir <path>", "with --from-journey: the journeys directory (default: the repo's .jevitate/journeys; outside a repo ~/.jevitate/journeys)")
    .option(
      "--strategy <name>",
      "exploration strategy: goal (default) | coverage | exploratory | adversarial | usability (UX review: ranked, cited findings)",
      "goal",
    )
    .option("--goal <text>", "natural-language goal / job (required for --strategy goal and usability)")
    .option("--app-class <class>", "app class for UX calibration (required for --strategy usability), e.g. consumer|admin|internal")
    .option(
      "--show <labels>",
      "opt-in filter on the quality grade (comma list of actionable,relevant-minor,generic,wrong); others are suppressed and counted; default JEVITATE_UX_SHOW, then ~/.jevitate/config.json ux.show, then ALL grades — the grader is uncalibrated (#133), so by default every finding is shown with its grade",
    )
    .option(
      "--min-confidence <n>",
      "(--strategy usability) findings below this FINDING confidence (0..1, a finding's own violation/applicability/grounding score — NOT its quality-grade confidence, a separate independent-grader number shown as finding.quality.confidence) are suppressed and counted in report.suppressed; default JEVITATE_UX_MIN_CONFIDENCE, then ~/.jevitate/config.json ux.minConfidence, then 0.3",
    )
    .option(
      "--max-findings-per-page <n>",
      "(--strategy usability) cap on UX findings per route/page, highest-confidence first; the rest are counted in report.suppressed as per-page-cap, never dropped silently; default JEVITATE_UX_MAX_FINDINGS_PER_PAGE, then ~/.jevitate/config.json ux.maxFindingsPerPage, then 5",
    )
    .option(
      "--product <file>",
      "(--strategy usability) product facts JSON (plans/prices, key journeys, each page's intended next step) the review checks screens against in code; default .jevitate/product.json in the project when present (docs/ux-findings.md)",
    )
    .option(
      "--probe-guards",
      "(--strategy usability) opt in to clicking each destructive control once to check for a confirmation step — fail-safe: every write and destructive-looking request is aborted, and a page with an open WebSocket/EventSource or a service worker is not probed; without it those claims are reported unverifiable (docs/ux-findings.md)",
    )
    .option("--polish", "(--strategy usability) polish each verified UX finding's recommendation with one generation call (opt-in; the default prose is built from templates)")
    .option(
      "--success <spec>",
      [
        "independent success check (repeatable; every one must hold; --strategy goal and usability). Kinds:",
        "urlIncludes:<text> | visible:<d> | textIncludes:<d>|<text> (case-insensitive) | count:<d>|min=<n>,max=<n>",
        "| valueEquals:<d>|<value> (a form control's value) | reloadThen:<check> (reload first: proves it persisted)",
        "| visual state (#148, read and decided by code): style:<d>|<prop><op><value> (computed style of every match;",
        "<prop> an allowlisted CSS property or a channel of one, e.g. alpha(background-color)>0, color=rgb(255, 0, 0); op = != > >= < <=)",
        "| inViewport:<d>[|min=<ratio>] (visible fraction, default 0.5) | box:<d>|minWidth=<n>,maxWidth=<n>,minHeight=<n>,maxHeight=<n>",
        "| overlaps:<d>|<d2> | noOverlap:<d>|<d2> | attr:<d>|<name>=<value> (or <name> present, !<name> absent)",
        "| flashed:<d>|class=<cls> (or attr=<name>, animation)[|withinMs=<n>] (a transient state gained after the last user input)",
        "| requestMade:<METHOD> <path-glob> | responseStatus:<METHOD> <path-glob>=<2xx|4xx|code>.",
        "<d> is testId=..;role=..;name=..;label=..;text=..;css=.. or a CSS selector such as [data-testid=x].",
        "<path-glob> must start with \"/\" (it matches the request's path, e.g. /api/profile/* or /api/**); * as METHOD matches any method.",
        "e.g. --success 'requestMade:PUT /api/profile' --success 'reloadThen:valueEquals:[data-testid=last-name]|Litmus'.",
        "Omit it for a find-out goal (e.g. \"find out how many contacts... report the answer\"): the run must then end",
        "with the model's own `report` op, and the grounded answer (#101) is the verdict — no page/network check needed.",
      ].join(" "),
      (v, prev: string[]) => [...prev, v],
      [] as string[],
    )
    .option(
      "--success-when <when>",
      "when the --success page checks must hold: final (default; on the final page) | held (on the final page, or all together at any settled step — a one-time secret, a toast) | " +
        "each (each went from not holding to holding at some settled step, in any order — checks on different pages; the run stops once all have). reloadThen is always final",
    )
    .option(
      "--allow-vacuous-checks",
      "downgrade a vacuous --success check to a warning. By default a check satisfied before the run's first action — a page check that held on the seed page and never changed " +
        "(an empty result container), a requestMade/responseStatus matched only by a page-load or polling request — FAILS: it cannot verify the goal",
    )
    .option(
      "--action-deltas",
      "opt-in (#303; every --strategy, not --feature): record what each action changed on the page — an accessibility snapshot before and after, announcements, " +
        "the action's requests — redacted, with a code verdict per step (no-change | relevant-change | inconclusive) used by the goal loop's no-progress check and a persistence re-check after writes (goal), and as defect evidence (adversarial, coverage); " +
        "adds `delta` to every transcript step (and Recording step, goal) and `actionDeltas` to the result. Costs about 50-100 ms per action on a small page, 0.3-0.5 s on a large one",
    )
    .option("--feature <name>", "run the capability-scoped feature-testing mission (instead of --goal/--success)")
    .option(
      "--route <glob>",
      "in-scope route glob (repeatable), e.g. /thread/** — for --feature it replaces the default scope (the start URL's route and everything under it); it widens --strategy adversarial/coverage/exploratory beyond the start URL's route",
      (v, prev: string[]) => [...prev, v],
      [] as string[],
    )
    .option(
      "--scope <mode>",
      "--strategy coverage/exploratory: 'app' widens containment to the whole app (same as --route '/**'); default: the start URL's route plus --route globs",
    )
    .option(
      "--allow <origin>",
      "authorized origin (repeatable); REPLACES the default allowlist when given (the URL's own origin is used only when --allow is omitted entirely) -- include the URL's own origin explicitly if you still need it",
      (v, prev: string[]) => [...prev, v],
      [] as string[],
    )
    .option(
      "--secret <value|env:VAR>",
      "REDACTION ONLY: a secret/PII value kept out of every model call and artifact (repeatable); env:VAR reads it from the environment (preferred: a literal is visible in the process list and shell history). It is never typed into a field — to log in, bind it with --secret-field (or start from --storage-state)",
      (v, prev: string[]) => [...prev, v],
      [] as string[],
    )
    .option(
      "--secret-field <binding>",
      "goal/usability strategy: '<label|testId|type|id|name>=<value>=env:<VAR>' (repeatable), e.g. 'label=Password=env:APP_PASSWORD'. When the run types into a matching field, code types $VAR itself; the model sees only «secret:VAR» and the Recording {redacted:true}",
      (v, prev: string[]) => [...prev, v],
      [] as string[],
    )
    .option(
      "--totp <binding>",
      "goal/usability strategy: '<descriptor>=env:<VAR>' with $VAR a base32 TOTP seed (repeatable), e.g. 'label=Authentication code=env:APP_TOTP_SEED'. The 6-digit code is computed locally (RFC 6238) when the field is typed; the seed never reaches a model or disk",
      (v, prev: string[]) => [...prev, v],
      [] as string[],
    )
    .option(
      "--type-fixture <binding>",
      "goal strategy: '<label|testId|type|id|name>=<value>=<file>' (repeatable), e.g. 'label=Paste your text=./fixtures/import.txt'. When the run types into a matching field, code types the file's exact text verbatim (line breaks kept, never paraphrased or capped); the model sees only «fixture:<file name>». Recorded as typed unless it holds a --secret",
      (v, prev: string[]) => [...prev, v],
      [] as string[],
    )
    .option(
      "--fixture <path>",
      "local file the upload op attaches to a file input (goal and usability strategies); must exist",
    )
    .option(
      "--storage-state <file>",
      "Playwright storageState JSON to start the session authenticated (deterministic login pre-step); must exist",
    )
    .option(
      "--actor <name=storageState>",
      "multi-actor mission (#147, goal only; repeatable): the FIRST actor is the primary (the only one the model drives, " +
        "from its own storageState); every other actor is an observer in its OWN fresh context that only runs the " +
        "--invariants' cross-actor checks (capture + probe as:/deniedAs) — never clicks or types. Replaces --storage-state",
      (v: string, prev: string[]) => [...prev, v],
      [] as string[],
    )
    .option(
      "--save-storage-state <file>",
      "write the context's storageState (cookies + origin storage) here when the run ends; mode 0600, contents never logged. " +
        "Useful with a rotating refresh token: --storage-state's file goes stale after one authenticated run refreshes it, " +
        "so point --save-storage-state at the SAME file (or a new one) to keep it usable for the next run. " +
        "Written on every exit path -- a crash or a SIGTERM/SIGINT kill included (#159), not only a clean end -- but " +
        "never over a good file with a session that already looks lost/logged-out; the last known-good state is used " +
        "instead, or nothing is written if none was ever captured.",
    )
    .option("--max-actions <n>", "hard cap on executed actions", positiveIntArg)
    .option("--max-decisions <n>", "hard cap on model decisions", positiveIntArg)
    .option(
      "--stall-timeout <seconds>",
      "--strategy coverage/exploratory and --feature: end the run inconclusive (stalled) when no step completes within this many seconds (default 120)",
      positiveNumberArg,
    )
    .option(
      "--reply-wait-ms <ms>",
      "conversational pages: how long to keep waiting for a reply while the page shows no sign of working on one " +
        "(goal and usability; default 60000). While a request the message started is in flight, a busy indicator shows, " +
        "or the reply is still growing, the wait continues up to --reply-ceiling-ms",
      positiveIntArg,
    )
    .option(
      "--reply-ceiling-ms <ms>",
      "conversational pages: hard ceiling on one reply wait, however busy the page stays (default 180000; never below --reply-wait-ms)",
      positiveIntArg,
    )
    .option(
      "--reply-max-chars <n>",
      "conversational pages: cap on each generated chat message (goal and usability; default 300)",
      intArg({ min: 20, max: 2000 }),
    )
    .option(
      "--job-wait-ms <ms>",
      "goal and usability: while the page shows an in-progress status (\"Simulating…\", aria-busy, a job \"is running\"), " +
        "waits keep waiting with backoff — and a model 'blocked' is deferred — up to this budget (default: --reply-ceiling-ms, 180000); " +
        "it also bounds a busy indicator the app visibly keeps working behind (live progress, a job poll) before it is a hang, " +
        "and a wait the page documents (\"usually takes a minute\") can raise it",
      positiveIntArg,
    )
    .option(
      "--deny <pattern>",
      "a control no mission may click (repeatable): an accessible-name regex (/Archive/i or Archive) or a descriptor role=button;name=Archive. " +
        "Session-ending (Sign out), destructive (Delete, Revoke, Rotate) and paid (Buy, Run simulation, Generate, Send invite) controls are refused by default",
      (v, prev: string[]) => [...prev, v],
      [] as string[],
    )
    .option(
      "--paid <pattern>",
      "an app control that costs money or credits (repeatable; same syntax as --deny), e.g. /^(Analyze|Draft|Improve)\\b/i: treated like the built-in paid " +
        "vocabulary — the budget guard sees it, hang replays never repeat it, and a goal that asks for it may still click it",
      (v, prev: string[]) => [...prev, v],
      [] as string[],
    )
    .option(
      "--allow-destructive",
      "let missions click session-ending, destructive and paid controls (a --deny pattern still holds). A goal run already may click one its goal asks for",
    )
    .option(
      "--dialogs <policy>",
      "native window.confirm/prompt dialogs: dismiss (default) or accept. accept still dismisses one whose message names a session-ending, " +
        "destructive or paid action the run may not take (without --allow-destructive or a goal asking for it); every dialog is logged",
    )
    .option(
      "--allow-writes",
      "let a find-out goal (no --success check, ended by report) change the app. By default it is read-only: controls that start a write flow " +
        "(checkout, upgrade, create, save, submit…) are refused and the write requests an action fires are blocked, unless the goal itself asks for a change",
    )
    .option(
      "--allow-write <glob>",
      "a write-request path a read-only find-out goal never blocks (repeatable; ** spans segments; a glob starting with https:// matches " +
        "origin + path, e.g. https://abc.supabase.co/rest/v1/**), beyond the built-in auth-refresh ones " +
        "(**/refresh*, **/token*, **/oauth/**, **/auth/**/refresh*). The app's background writes outside an action always pass",
      (v, prev: string[]) => [...prev, v],
      [] as string[],
    )
    .option(
      "--read-rpc <glob>",
      "a POST request that only READS (repeatable): an RPC-method glob (Estimate*, pkg.Service/Preview*) or a path glob (/api/search*). " +
        "gRPC-web/Connect Get*/List*/Search*/Find*/Watch*/Stream*/Count*/Describe*/Read* methods are reads already. Reads are never guarded or reported as duplicate writes",
      (v, prev: string[]) => [...prev, v],
      [] as string[],
    )
    .option("--real", "use live Jev + OpenRouter gateways (requires keys)", false)
    .option("--fake-ai", "use deterministic fake gateways (pipeline smoke only)", false)
    .option("--out <dir>", "directory to write the emitted Recording")
    .option(
      "--file-issues",
      "file findings as issues (needs a repo: --issue-repo or ~/.jevitate/filing.json); default: drafts only",
    )
    .option("--issue-repo <owner/name>", "the system-under-test repo findings for THIS target are filed to")
    .option("--hang-replays <n>", "fresh-context replays that confirm a hang (default 2; 0 = don't replay, the hang is reported unconfirmed)", nonNegativeIntArg)
    .option(
      "--hang-replay-writes",
      "let hang replays re-send a paid/destructive write the run sent (default: such a hang is reported inconclusive, never replayed)",
    )
    .option(
      "--settle-ignore <pattern>",
      "a request URL pattern the target marks as background (never pending work; repeatable, * wildcard)",
      (v, prev: string[]) => [...prev, v],
      [] as string[],
    )
    .option("--long-poll-ms <n>", "a request pending this long on an interactive page is a long-poll (default 5000)", nonNegativeIntArg)
    .option(
      "--api-prefix <path>",
      "a path prefix whose requests are the app's API in the timing summary (repeatable), e.g. /api/",
      (v, prev: string[]) => [...prev, v],
      [] as string[],
    )
    .option(
      "--ignore-no-progress <pattern>",
      "a route / action label / busy indicator where ui-no-progress is expected (repeatable, * wildcard)",
      (v, prev: string[]) => [...prev, v],
      [] as string[],
    )
    .option("--jevitate-repo <owner/name>", "where jevitate engine findings are filed (default matt-cochran/jevitate)")
    .option(
      "--min-control-coverage <ratio>",
      "adversarial: share of the target's controls (0..1) a run must exercise before 'found nothing' is clean (default 0.25); below it the run is inconclusive",
      ratioArg,
    )
    .option(
      "--no-require-form-submit",
      "adversarial: do not require a submitted form for a clean result (default: required when the target has a form)",
    )
    .option(
      "--invariants <file>",
      "app-declared invariants JSON (repeatable; goal, coverage, exploratory, adversarial, --feature): checked around every action, a violation is a defect (exit 1). Validated before any browser opens; probes are GET/HEAD on an --allow origin only",
      (v, prev: string[]) => [...prev, v],
      [] as string[],
    )
    .option(
      "--log-source <spec>",
      "backend log source (repeatable; every strategy, incl. usability): file:<path> (tailed from its current end) | docker:<container> (docker logs -f --since 0s) | cmd:<command> (needs --allow-log-cmd). Read-only, operator-declared, never the model's choice. Error/warning lines are correlated to the step they landed during and attached to its transcript evidence, redacted",
      (v, prev: string[]) => [...prev, v],
      [] as string[],
    )
    .option(
      "--allow-log-cmd",
      "opt-in: a --log-source cmd:<command> may run as a subprocess (operator-declared only; refused otherwise)",
      false,
    )
    .option(
      "--log-defect <level|/regex/>",
      "backend log lines matching this (repeatable) become a server-log defect: a level (error|warn|info|debug, matched as level>=this) or a /regex/flags/ over the raw line. Its fingerprint is the normalized message (ids/numbers/uuids/timestamps stripped) plus the correlated route; verify-fix re-checks it by re-tailing the same --log-source(s)",
      (v, prev: string[]) => [...prev, v],
      [] as string[],
    )
    .option(
      "--log-quiet-ok <spec>",
      "declares a --log-source spec (exact match, repeatable) as legitimately quiet: zero lines from it does not make the --log-defect oracle unhealthy (#169). Without it, a declared source that opened but delivered not one line makes an otherwise-clean run inconclusive, same as one that failed to open",
      (v, prev: string[]) => [...prev, v],
      [] as string[],
    )
    .option(
      "--log-ignore <regex|substring>",
      "excludes known-noise backend log lines (repeatable, /regex/flags/ over the raw line or a plain substring) from BOTH correlation and the --log-defect oracle (#169 item 3) — e.g. a periodic background job's own expected error. Counted separately as serverLogs.ignoredLines; never makes --log-quiet-ok unnecessary, since an ignored line still proves the source is being tailed",
      (v, prev: string[]) => [...prev, v],
      [] as string[],
    )
    .option(
      "--log-scope <regex|substring>",
      "attributes only backend log lines matching this (repeatable, /regex/flags/ or a plain substring, e.g. a tenant id) to the run (#282); the rest count as serverLogs.ignoredLines. For concurrent runs tailing one log. A line carrying one of the run's own correlation ids is in scope",
      (v, prev: string[]) => [...prev, v],
      [] as string[],
    )
    .option(
      "--log-correlation-header <name>",
      "another request/response header that carries a correlation id (repeatable; built in: traceparent, x-request-id, x-correlation-id, request-id, x-amzn-trace-id, x-b3-traceid, x-cloud-trace-context). A log line carrying a request's id is attached to that exact request and the step that sent it, not by time (#204)",
      (v, prev: string[]) => [...prev, v],
      [] as string[],
    )
    .option(
      "--log-id-pattern </regex/>",
      "how a correlation id is written in your log lines, when not as trace_id=/request_id=/correlation_id= or a traceparent (repeatable; the first capture group is the id). Once ids correlate, a line with another request's id is never attributed to the run (#204)",
      (v, prev: string[]) => [...prev, v],
      [] as string[],
    )
    .option(
      "--log-triage",
      "#313: record the run's whole signal timeline (backend lines at every level, the browser's console, page errors, failed requests) to <run>.signals.jsonl, " +
        "and attach to each defect only the lines that relate to it (defects[].relatedLogs): code keeps the lines correlated to its request and prefilters its step's window, " +
        "then, with --real, Jev scores each remaining line's relevance (log text goes to the judgment model, redacted — operator opt-in, never an MCP argument). Needs --log-source",
    )
    .option(
      "--server-log-drain-ms <ms>",
      "how long to keep tailing --log-source after the run's last action, to catch async backend work that settles after the browser gave up (default 3000)",
      nonNegativeIntArg,
    )
    .option(
      "--repeat <n>",
      "run the mission N times, one after another, each in a fresh browser context, and vote (#141): findings seen in fewer than --min-agreement runs are reported as flaky, not counted",
    )
    .option("--min-agreement <k>", "with --repeat: runs a finding (and the outcome) must recur in to count (default: a majority of N)")
    .option(
      "--persona <name=storageState>",
      "run the same mission once per persona (repeatable), serially, each from its own storageState, and diff them (#143): requests, statuses (a 403 vs 200 is a candidate RBAC finding), controls, outcome",
      (v, prev: string[]) => [...prev, v],
      [] as string[],
    )
    .option("--personas <file>", "personas JSON: {\"<name>\": \"<storageState>\"} or {\"personas\": [{\"name\", \"storageState\"}]}")
    .option(
      "--check-overflow",
      "check the horizontal-overflow (#149) and vertical-clipping (#302: text cut off by a fixed-height box or above the page top) hard signals even at a desktop (>=1024px) viewport — --strategy coverage/exploratory " +
        "(a defect), adversarial (a defect) or usability (a signal finding). " +
        "On by default whenever --viewport/--device emulates a viewport narrower than 1024px",
    )
    .option(
      "--ignore-overflow <selector>",
      "a CSS selector (repeatable) whose overflow or clipping is intentional — excluded from the horizontal-overflow and vertical-clipping signals, like --ignore-no-progress",
      (v, prev: string[]) => [...prev, v],
      [] as string[],
    )
    .option(
      "--evidence-video",
      "per defect: replay its minimal repro with captions + the failing step marked, record a masked clip and before/at screenshots (defects[].evidence; linked from drafts)",
    )
    .option("--json", "emit the JSON envelope (default: a human summary)")
    .addHelpText(
      "after",
      [
        "",
        "Authenticated missions:",
        "  --secret only REDACTS a value; it is never typed. Prefer starting logged in: save a Playwright",
        "  storageState once (e.g. `npx playwright codegen --save-storage=auth.json <url>`) and pass",
        "  --storage-state auth.json. To drive a login/signup form, bind fields to environment variables:",
        "  --secret-field 'label=Password=env:APP_PASSWORD' and, for MFA, --totp 'label=Code=env:APP_TOTP_SEED'.",
        "  See 'Authenticated missions' in the README.",
      ].join("\n"),
    )
    .addHelpText(
      "after",
      [
        "",
        "Viewport/device emulation (#149):",
        "  Default: Playwright's own default viewport (1280x720, desktop, no touch) — nothing narrower",
        "  unless --viewport or --device is given (mutually exclusive). --device validates against",
        "  Playwright's built-in devices registry (viewport + scale + mobile/touch + UA); an unknown",
        "  name is refused before any browser opens. The emulation is recorded on the Recording, so",
        "  verify-fix/regression replay reproduce under the SAME device by default.",
      ].join("\n"),
    )
    .addHelpText("after", EXPLORE_OUTCOME_HELP)
    .action(async function (this: Command) {
      const o = this.opts<{
        invariants: string[];
        logSource: string[];
        logTriage?: boolean;
        allowLogCmd?: boolean;
        logDefect: string[];
        logQuietOk: string[];
        logIgnore: string[];
        logScope: string[];
        logCorrelationHeader: string[];
        logIdPattern: string[];
        serverLogDrainMs?: string;
        actor: string[];
        repeat?: string;
        minAgreement?: string;
        persona: string[];
        personas?: string;
        minControlCoverage?: string;
        requireFormSubmit: boolean;
        fileIssues?: boolean;
        issueRepo?: string;
        /** Parsed by commander's `nonNegativeIntArg` (#275: a number, not a string). */
        hangReplays?: number;
        settleIgnore: string[];
        apiPrefix: string[];
        longPollMs?: string;
        ignoreNoProgress: string[];
        jevitateRepo?: string;
        url?: string;
        strategy?: string;
        goal?: string;
        appClass?: string;
        minConfidence?: string;
        maxFindingsPerPage?: string;
        show?: string;
        product?: string;
        polish?: boolean;
        probeGuards?: boolean;
        success: string[];
        successWhen?: string;
        allowVacuousChecks?: boolean;
        actionDeltas?: boolean;
        feature?: string;
        route: string[];
        scope?: string;
        allow: string[];
        secret: string[];
        secretField: string[];
        totp: string[];
        typeFixture: string[];
        fixture?: string;
        storageState?: string;
        saveStorageState?: string;
        maxActions?: string;
        maxDecisions?: string;
        stallTimeout?: string | number;
        replyWaitMs?: string;
        replyCeilingMs?: string;
        replyMaxChars?: string;
        jobWaitMs?: string;
        deny: string[];
        paid: string[];
        allowDestructive?: boolean;
        dialogs?: string;
        allowWrites?: boolean;
        allowWrite: string[];
        hangReplayWrites?: boolean;
        readRpc: string[];
        real?: boolean;
        fakeAi?: boolean;
        out?: string;
        checkOverflow?: boolean;
        ignoreOverflow: string[];
        json?: boolean;
        evidenceVideo?: boolean;
        fromJourney?: string;
        atStep?: string;
        param: Record<string, string>;
        journeysDir?: string;
      } & BrowserLaunchFlags & DemoFlags & FixtureFlags & EmulationFlags & ScreenshotsFlags & EnvironmentFlags>();
      // #210: one output rule for every strategy — the envelope with --json, a human summary without.
      const emitExplore = (envelope: JsonEnvelope<unknown>, exitCode?: number, human: (data: unknown) => string = formatMissionHuman): void =>
        emitCommandResult(program, envelope, { json: o.json === true, command: "explore", human, ...(exitCode === undefined ? {} : { exitCode }) });

      // #230: an unknown --strategy must be refused before any other required-option message — it
      // would otherwise fall through to the default goal-strategy path and silently run a goal
      // mission. Checked first, ahead of every other validation below.
      if (o.strategy !== undefined && !EXPLORE_STRATEGIES.includes(o.strategy as (typeof EXPLORE_STRATEGIES)[number])) {
        emitExplore(fail("E_EXPLORE_ARGS", `unknown strategy ${JSON.stringify(o.strategy)} (one of ${EXPLORE_STRATEGIES.join(", ")})`));
        return;
      }
      // #334: a mistyped --dialogs never silently means "dismiss".
      if (o.dialogs !== undefined && o.dialogs !== "dismiss" && o.dialogs !== "accept") {
        emitExplore(fail("E_EXPLORE_ARGS", `--dialogs must be dismiss or accept, got ${JSON.stringify(o.dialogs)}`));
        return;
      }

      // #195: a session file never lands in the repo's .jevitate/ (refused before any run, multi-runs included).
      if (o.saveStorageState !== undefined) {
        try {
          assertSessionFileOutsideProject(o.saveStorageState, "--save-storage-state");
        } catch (err) {
          if (!(err instanceof SessionFileInProjectError)) throw err;
          emitExplore(fail(err.code, err.message));
          return;
        }
      }
      const strategy = o.strategy ?? "goal";
      // #293 journey-anchored exploration: the Journey, step, params and environment are resolved (and
      // refused, exit 64) before anything else — the start URL every later check uses is where the
      // Journey's prefix lands.
      let journeyPrefix: JourneyPrefix | undefined;
      const anchoredFlags = [o.fromJourney, o.atStep, o.journeysDir, o.env, o.baseUrl].some((v) => v !== undefined);
      if (anchoredFlags || Object.keys(o.param).length > 0) {
        const refuse = (message: string): void => emitExplore(fail("E_EXPLORE_ARGS", message));
        if (o.fromJourney === undefined || o.atStep === undefined) {
          refuse("--from-journey and --at-step go together (and --param, --env, --base-url and --journeys-dir need them)");
          return;
        }
        if (o.url !== undefined) {
          refuse("--url cannot be combined with --from-journey: the mission starts where the Journey's prefix leaves the page");
          return;
        }
        if (o.feature !== undefined || !(ANCHORED_STRATEGIES as readonly string[]).includes(strategy)) {
          refuse(`--from-journey supports --strategy ${ANCHORED_STRATEGIES.join(", ")} (not --feature)`);
          return;
        }
        if (wantsMultiRun(o) || o.actor.length > 0) {
          refuse("--from-journey runs one anchored mission: --repeat, --persona, --personas and --actor are not supported with it (a campaign runs several)");
          return;
        }
        // #293 sweep: `--at-step all|anchors` runs the strategy from EVERY step (or anchor), each in a
        // fresh session with --fixtures restored around it, --max-actions/--max-decisions split evenly
        // over the stop points, and reads them as one deduped report (a one-job campaign).
        // #312: one anchored step with a state restore (--fixtures/--before/--after) on a non-goal
        // strategy runs the same way — as a one-stop campaign, whose runner restores around the run.
        const restoredSingle =
          !isSweepMode(o.atStep) && strategy !== "goal" && (o.fixtures !== undefined || o.before !== undefined || o.after !== undefined);
        if (isSweepMode(o.atStep) || restoredSingle) {
          if (o.real !== true && o.fakeAi !== true) {
            emitExplore(fail("E_AI_SETUP_REQUIRED", "a sweep's missions are model-driven: pass --real or --fake-ai"));
            return;
          }
          const journeysDir = resolveJourneysDir(deps, o.journeysDir);
          const abs = (p: string): string => resolvePath(p);
          const spec = {
            version: 1,
            name: restoredSingle ? `${o.fromJourney} at step ${o.atStep.trim()} (${strategy}, restored)` : `sweep of ${o.fromJourney} (${o.atStep}, ${strategy})`,
            ...(o.env === undefined ? {} : { env: o.env }),
            ...(o.baseUrl === undefined ? {} : { baseUrl: o.baseUrl }),
            ...(o.storageState === undefined ? {} : { storageState: abs(o.storageState) }),
            ...(o.fixtures === undefined ? {} : { fixtures: abs(o.fixtures) }),
            ...(o.before === undefined ? {} : { before: o.before }),
            ...(o.after === undefined ? {} : { after: o.after }),
            discovery: false,
            maxRuns: CAMPAIGN_LIMITS.maxRuns,
            jobs: [
              {
                id: "sweep",
                journey: o.fromJourney,
                params: o.param,
                anchors: restoredSingle ? [o.atStep.trim()] : o.atStep.trim(),
                strategies: [strategy],
                ...(o.goal === undefined ? {} : { goal: o.goal }),
                ...(o.appClass === undefined ? {} : { appClass: o.appClass }),
                ...(o.success.length === 0 ? {} : { success: o.success }),
                ...(o.maxActions === undefined ? {} : { maxActions: Number(o.maxActions) }),
                ...(o.maxDecisions === undefined ? {} : { maxDecisions: Number(o.maxDecisions) }),
              },
            ],
          };
          try {
            const plan = await validateCampaignSpec(spec, resolvePath("explore-sweep.json"), {
              journeysDir,
              allowShellHooks: o.allowShellHooks === true,
              ...(o.hookTimeoutMs === undefined ? {} : { hookTimeoutMs: Number(o.hookTimeoutMs) }),
              environmentSeams: environmentSeams(deps),
            });
            const result = await runCampaign(plan, {
              newProgram: () => buildProgram(deps),
              journeysDir,
              missionTargetsDir: resolveMissionTargetsDir(deps),
              ...(o.out === undefined ? {} : { outDir: o.out }),
              ...(o.real === true ? { real: true } : {}),
              ...(o.fakeAi === true ? { fakeAi: true } : {}),
              missionArgs: forwardedArgv(this, SWEEP_OWNED),
            });
            emitExplore(ok(withEngine({ sweep: { journeyId: o.fromJourney, mode: restoredSingle ? "step" : o.atStep.trim(), ...(restoredSingle ? { atStep: o.atStep.trim() } : {}), strategy, stops: plan.totalRuns, budgetPerStop: { maxActions: plan.jobs[0]?.maxActions, ...(plan.jobs[0]?.maxDecisions === undefined ? {} : { maxDecisions: plan.jobs[0].maxDecisions }) } }, ...result })), result.exitCode, formatCampaignHuman);
          } catch (err) {
            if (err instanceof CampaignSpecError) emitExplore(fail("E_EXPLORE_ARGS", err.message));
            else emitExplore(fail("E_EXPLORE_RUN", String(err instanceof Error ? err.message : err)));
          }
          return;
        }
        try {
          const environment = environmentFromFlags(
            { ...(o.env === undefined ? {} : { env: o.env }), ...(o.baseUrl === undefined ? {} : { baseUrl: o.baseUrl }) },
            environmentSeams(deps),
          );
          // The environment's own session applies when --storage-state names none (as `journey run`).
          if (o.storageState === undefined && environment?.storageState !== undefined) o.storageState = environment.storageState;
          journeyPrefix = await resolveJourneyPrefix({
            dir: resolveJourneysDir(deps, o.journeysDir),
            id: o.fromJourney,
            atStep: o.atStep,
            params: o.param,
            ...(environment === undefined ? {} : { environment }),
            ...(o.storageState === undefined ? {} : { storageState: o.storageState }),
            dbPath: resolveDbPath(deps),
            environmentFlags: { ...(o.env === undefined ? {} : { env: o.env }), ...(o.baseUrl === undefined ? {} : { baseUrl: o.baseUrl }) },
          });
        } catch (err) {
          if (isEnvironmentError(err) || err instanceof JourneyPrefixArgsError) emitExplore(fail(err.code, err.message));
          else if (err instanceof UnknownJourneyError) emitExplore(fail("E_UNKNOWN_JOURNEY", err.message));
          else if (err instanceof ParamValidationError) emitExplore(fail("E_INVALID_PARAMS", err.message));
          else if (err instanceof JourneyRequiresAuthError) emitExplore(fail("E_JOURNEY_REQUIRES_AUTH", err.message));
          else emitExplore(fail("E_EXPLORE_ARGS", err instanceof Error ? err.message : String(err)));
          return;
        }
        // The prefix types its secret params into the page the mission perceives: they are redacted like
        // --secret. Coverage/exploratory carry no redaction set, so a prefix with secrets refuses them.
        if (journeyPrefix.secrets.length > 0 && (strategy === "coverage" || strategy === "exploratory")) {
          refuse(`journey '${o.fromJourney}' types a secret param before step ${journeyPrefix.branch.step}: --strategy ${strategy} cannot redact it — use goal, adversarial or usability`);
          return;
        }
        o.url = journeyPrefix.startUrl;
        // Default allowlist: the origins the Journey's steps may be on (the environment's), not just the landing's.
        if (o.allow.length === 0) o.allow = [...journeyPrefix.allowedOrigins];
      }
      const withPrefix = journeyPrefix === undefined ? {} : { journeyPrefix };
      /** #293: a prefix that no longer replays, or a site policy that refused it — typed, handled once for every strategy. */
      const emitJourneyFailure = (err: unknown): boolean => {
        if (err instanceof JourneyPrefixStaleError) {
          emitExplore(ok(withEngine(journeyStaleResult(err, strategy))), EXIT_CODES.inconclusive);
          return true;
        }
        if (err instanceof SiteGateRefusedError) {
          emitExplore(fail(err.code, err.message));
          return true;
        }
        return false;
      };
      // #195: `--secret env:VAR` is resolved from the environment before anything runs (fail closed).
      try {
        const resolved = resolveSecretArgs(o.secret, process.env, "--secret");
        if (resolved.literals > 0) program.configureOutput().writeErr?.(LITERAL_SECRET_WARNING);
        o.secret = [...resolved.secrets, ...(journeyPrefix?.secrets ?? [])];
      } catch (err) {
        if (!(err instanceof SecretArgError)) throw err;
        emitExplore(fail("E_EXPLORE_ARGS", err.message));
        return;
      }
      // #245 demo mode: resolved (and a headed run without a display refused, exit 64) before any
      // browser opens — a multi-run's every run re-resolves the same flags.
      let browser: ReturnType<typeof browserRunFromFlags>;
      try {
        browser = browserRunFromFlags(o, deps.explore?.env ?? process.env);
        // #256: a chrome-extension:// --url must be a loaded extension's; loaded extensions' origins are allowed.
        assertExtensionTargetLoaded(o.url, browser);
        o.allow = allowWithExtensions(o.url, o.allow, browser);
      } catch (err) {
        emitExplore(fail("E_EXPLORE_ARGS", err instanceof Error ? err.message : String(err)));
        return;
      }
      // #251: an unusable --screenshots value is a usage error (64), refused before any browser opens.
      let screenshots: ScreenshotsSpec | undefined;
      try {
        screenshots = parseScreenshotsArg(o.screenshots);
      } catch (err) {
        emitExplore(fail("E_EXPLORE_ARGS", err instanceof Error ? err.message : String(err)));
        return;
      }
      // #251/#250: the capture options every strategy's runner takes.
      const screenshotsOpt = { ...(screenshots === undefined ? {} : { screenshots }), ...(o.evidenceVideo === true ? { evidenceVideo: true } : {}) };
      if (browser?.headed === true && (wantsMultiRun(o) || o.actor.length > 1)) {
        program.configureOutput().writeErr?.(multiWindowWarning(o.actor.length > 1 ? "several --actor sessions" : "--repeat/--persona"));
      }
      // Repeat-and-vote (#141) / persona matrix (#143): the same command, run sequentially and aggregated.
      if (wantsMultiRun(o)) {
        try {
          const plan = resolveMultiRunPlan(o);
          const result = await runExploreMultiRun({
            cmd: this,
            newProgram: () => buildProgram(deps),
            plan,
            strategy,
            ...(o.out === undefined ? {} : { out: o.out }),
            // #220: a killed multi-run prints ITS partial summary, by this command's own output rule.
            killOutput: (partial) => (o.json === true ? `${JSON.stringify(ok(withEngine(partial)))}\n` : formatMultiRunHuman(partial)),
          });
          emitExplore(ok(withEngine(result)), result.exitCode, formatMultiRunHuman);
        } catch (err) {
          if (err instanceof MultiRunArgsError) emitExplore(fail(err.code, err.message));
          else if (err instanceof MultiRunAbortedError) emitExplore(fail(err.envelope.error.code, err.envelope.error.message));
          else emitExplore(fail("E_EXPLORE_RUN", String(err instanceof Error ? err.message : err)));
        }
        return;
      }
      // #120: a killed run prints what this command would have printed — the envelope with --json,
      // else the human summary (#210) — before it exits.
      setKillSwitchOutput(o.json === true ? "envelope" : "human");
      const conversation = {
        ...(o.replyWaitMs === undefined ? {} : { replyWaitMs: Number(o.replyWaitMs) }),
        ...(o.replyCeilingMs === undefined ? {} : { replyCeilingMs: Number(o.replyCeilingMs) }),
        ...(o.replyMaxChars === undefined ? {} : { replyMaxChars: Number(o.replyMaxChars) }),
        ...(o.jobWaitMs === undefined ? {} : { jobWaitMs: Number(o.jobWaitMs) }),
      };
      if (
        (conversation.replyWaitMs !== undefined && !(Number.isInteger(conversation.replyWaitMs) && conversation.replyWaitMs > 0)) ||
        (conversation.replyCeilingMs !== undefined &&
          !(Number.isInteger(conversation.replyCeilingMs) && conversation.replyCeilingMs > 0)) ||
        (conversation.replyMaxChars !== undefined &&
          !(Number.isInteger(conversation.replyMaxChars) && conversation.replyMaxChars >= 20 && conversation.replyMaxChars <= 2000))
      ) {
        emitExplore(fail("E_EXPLORE_ARGS", "--reply-wait-ms and --reply-ceiling-ms must be positive integers; --reply-max-chars an integer in 20..2000"));
        return;
      }
      if (conversation.jobWaitMs !== undefined && !(Number.isInteger(conversation.jobWaitMs) && conversation.jobWaitMs > 0)) {
        emitExplore(fail("E_EXPLORE_ARGS", "--job-wait-ms must be a positive integer"));
        return;
      }
      // #154: refused BEFORE any browser opens — `nonNegativeIntArg` already rejects a bad value at
      // parse time (#275: the value is a number here). 0 is valid: "don't replay" — a hang is then
      // reported unconfirmed (inconclusive), never replayed and never a crash.
      try {
        validateDenyPatterns(o.deny);
        validateDenyPatterns(o.paid, "--paid");
      } catch (err) {
        emitExplore(fail("E_EXPLORE_ARGS", err instanceof Error ? err.message : String(err)));
        return;
      }
      // #149: refused BEFORE any browser opens (an unknown --device, or --viewport + --device together).
      let emulation: EmulationSpec | undefined;
      try {
        emulation = emulationFromFlags(o);
      } catch (err) {
        emitExplore(fail("E_EXPLORE_ARGS", err instanceof Error ? err.message : String(err)));
        return;
      }
      const overflow = { checkOverflow: o.checkOverflow ?? false, ignoreSelectors: o.ignoreOverflow };
      // Issue filing: drafts are always written; filing needs --file-issues (or config) AND a repo.
      let filing: FilingConfig | undefined;
      if (o.url !== undefined) {
        try {
          filing = resolveFilingConfig(
            loadFilingFileConfig(deps.explore?.filingConfigPath),
            {
              ...(o.fileIssues === undefined ? {} : { fileIssues: o.fileIssues }),
              ...(o.issueRepo === undefined ? {} : { issueRepo: o.issueRepo }),
              ...(o.jevitateRepo === undefined ? {} : { jevitateRepo: o.jevitateRepo }),
            },
            new URL(setupRefFreeUrl(o.url)).origin,
          );
        } catch (err) {
          if (err instanceof FilingConfigError) {
            emitExplore(fail(err.code, err.message));
            return;
          }
          if (!(err instanceof TypeError)) throw err;
          // An unparseable --url is refused by the authorized-target guard below.
        }
      }
      // Per-target settle/hang configuration: ~/.jevitate/targets.json by origin, plus flags.
      let target: TargetConfig | undefined;
      if (o.url !== undefined) {
        try {
          target = resolveTargetConfig(loadTargetsFile(deps.explore?.targetsConfigPath), new URL(setupRefFreeUrl(o.url)).origin, {
            settleIgnore: o.settleIgnore,
            ignoreNoProgress: o.ignoreNoProgress,
            apiPrefixes: o.apiPrefix,
            deny: o.deny,
            paid: o.paid,
            readRpc: o.readRpc,
            ...(o.allowDestructive === true ? { allowDestructive: true } : {}),
            ...(o.dialogs === undefined ? {} : { dialogs: o.dialogs as DialogPolicy }),
            ...(o.allowWrites === true ? { allowWrites: true } : {}),
            allowWrite: o.allowWrite,
            ...(o.hangReplayWrites === true ? { hangReplayWrites: true } : {}),
            ...(o.longPollMs === undefined ? {} : { longPollMs: Number(o.longPollMs) }),
          });
        } catch (err) {
          if (err instanceof TargetConfigError) {
            emitExplore(fail(err.code, err.message));
            return;
          }
          if (!(err instanceof TypeError)) throw err;
        }
      }
      const issueFiler =
        deps.explore?.issueFiler ??
        ((): IssueFilerPort =>
          new GitHubIssueFiler({ store: envCredentialStore(process.env, loadLocalCredentials()) }));
      // #250 --evidence-video: the runner attaches each defect's captioned repro clip + key
      // screenshots; drafts are filed only AFTER their media is linked (the run writes drafts only).
      const evidenceOn = o.evidenceVideo === true;
      const runFiling = filing === undefined ? undefined : evidenceOn ? { ...filing, enabled: false } : filing;
      const withEvidence = async <R extends object>(result: R): Promise<R> => {
        if (!evidenceOn) return result;
        let out = result;
        if (filing?.enabled === true) out = await fileDraftsWithEvidence(out, filing, issueFiler, clock.nowIso());
        return out;
      };
      // `--fixture` feeds the upload op, which only the explore loop (goal and
      // usability strategies) can issue. Refuse it elsewhere rather than
      // silently ignoring a file the user expected to be uploaded.
      if (o.fixture !== undefined && (o.feature !== undefined || (strategy !== "goal" && strategy !== "usability"))) {
        emitExplore(fail("E_EXPLORE_ARGS", "--fixture is supported only with --strategy goal or usability"));
        return;
      }
      // #198: product facts and polish shape the UX review's findings only.
      if ((o.product !== undefined || o.polish === true || o.probeGuards === true) && (o.feature !== undefined || strategy !== "usability")) {
        emitExplore(fail("E_EXPLORE_ARGS", "--product, --polish and --probe-guards are supported only with --strategy usability"));
        return;
      }
      // #225: success checks judge a goal / a usability job — every other strategy (and --feature) would
      // silently ignore them, so they are refused up front, never dropped.
      if (
        (o.success.length > 0 || o.successWhen !== undefined || o.allowVacuousChecks === true) &&
        (o.feature !== undefined || (strategy !== "goal" && strategy !== "usability"))
      ) {
        emitExplore(
          fail(
            "E_EXPLORE_ARGS",
            `--success, --success-when and --allow-vacuous-checks are supported only with --strategy goal or usability (not ${o.feature !== undefined ? "--feature" : `--strategy ${strategy}`})`,
          ),
        );
        return;
      }
      // #303: action deltas are recorded by the goal loop (goal and usability runs) only — refused
      // elsewhere, never silently ignored.
      if (o.actionDeltas === true && o.feature !== undefined) {
        emitExplore(fail("E_EXPLORE_ARGS", "--action-deltas is not supported with --feature (goal, usability, coverage, exploratory and adversarial runs record deltas)"));
        return;
      }
      if (o.storageState !== undefined && !existsSync(o.storageState)) {
        emitExplore(fail("E_EXPLORE_ARGS", `storage state not found: ${o.storageState}`));
        return;
      }
      // Multi-actor missions (#147): the first --actor is the primary, the rest are observers.
      let actors: MissionActors | null;
      try {
        actors = resolveMissionActors(o.actor);
      } catch (err) {
        if (!(err instanceof MultiRunArgsError)) throw err;
        emitExplore(fail(err.code, err.message));
        return;
      }
      if (actors !== null) {
        if (o.feature !== undefined || strategy !== "goal") {
          emitExplore(fail("E_EXPLORE_ARGS", "--actor is supported only with --strategy goal"));
          return;
        }
        if (o.storageState !== undefined) {
          emitExplore(fail("E_EXPLORE_ARGS", "--storage-state cannot be combined with --actor (the first --actor is the primary's session)"));
          return;
        }
      }
      // The primary's session: its --actor state, else --storage-state.
      const primaryStorageState = actors?.primary.storageState ?? o.storageState;
      // App-declared invariants (#86): validated (schema, observables, probe origins) BEFORE any browser.
      let invariants: InvariantSpec | undefined;
      // #135: authFrom.secret refs (env:VAR), resolved from the environment HERE — the one place this
      // package reads process.env for invariants — never inside @jevitate/explore or @jevitate/recording.
      let invariantAuthTokens: Map<string, string> | undefined;
      if (o.invariants.length > 0) {
        if (o.url !== undefined) {
          try {
            const loaded = loadInvariantFiles(o.invariants, {
              allowlist: resolveExploreAllowlist(o.url, o.allow),
              baseUrl: o.url,
              observers: actors?.observers.map((a) => a.name) ?? [],
            });
            invariants = loaded;
            invariantAuthTokens = loaded === undefined ? undefined : resolveInvariantAuthTokens(loaded, process.env);
            checkActorsAgainstSpec(actors, loaded);
          } catch (err) {
            if (err instanceof MultiRunArgsError) {
              emitExplore(fail(err.code, err.message));
              return;
            }
            if (!(err instanceof InvariantsFileError)) throw err;
            emitExplore(fail(err.code, err.message));
            return;
          }
        }
        // #147: captures and cross-actor checks run in the goal loop only — never silently skipped elsewhere.
        if (invariants?.capture !== undefined && (o.feature !== undefined || strategy !== "goal")) {
          emitExplore(fail("E_EXPLORE_ARGS", "invariants with capture (cross-actor checks) are supported only with --strategy goal"));
          return;
        }
      }
      const withInvariants = {
        ...(invariants === undefined ? {} : { invariants }),
        ...(invariantAuthTokens === undefined || invariantAuthTokens.size === 0 ? {} : { invariantAuthTokens }),
      };
      // Backend log sources (#142): validated (spec shape, --allow-log-cmd gate, matcher regexes)
      // BEFORE any browser opens — the same fail-closed discipline as --invariants above. Supported
      // on every strategy, INCLUDING usability (#142 follow-up): lines attach to usability steps the
      // same way, though a UX run's own outcome stays advisory (a server-log defect is still reported,
      // never gates the exit code — the same rule as every other UX finding).
      let serverLog: ServerLogOptions | undefined;
      if (o.logSource.length > 0 || o.logDefect.length > 0) {
        try {
          const sources = parseLogSourceSpecs(o.logSource, o.allowLogCmd ?? false);
          const logDefect = parseLogDefectSpecs(o.logDefect);
          const logIgnore = parseLogIgnoreSpecs(o.logIgnore);
          const logScope = parseLogScopeSpecs(o.logScope);
          const correlationHeaders = parseCorrelationHeaders(o.logCorrelationHeader);
          const idPatterns = parseLogIdPatterns(o.logIdPattern);
          serverLog = {
            sources,
            logDefect,
            allowLogCmd: o.allowLogCmd ?? false,
            quietOk: o.logQuietOk,
            logIgnore,
            logScope,
            correlationHeaders,
            idPatterns,
            ...(o.serverLogDrainMs === undefined ? {} : { drainMs: Number(o.serverLogDrainMs) }),
          };
        } catch (err) {
          if (err instanceof LogSourceSpecError || err instanceof LogSpecError) {
            emitExplore(fail(err.code, err.message));
            return;
          }
          throw err;
        }
      }
      if (o.logTriage === true) {
        if (serverLog === undefined) {
          emitExplore(fail("E_EXPLORE_ARGS", "--log-triage triages the run's backend and browser signals: it needs at least one --log-source"));
          return;
        }
        serverLog = { ...serverLog, triage: {} };
      }
      const withServerLog = serverLog === undefined ? {} : { serverLog };
      // Secret field bindings (#72): resolved from the environment here, typed by code in the goal loop.
      let secretFields: SecretField[] = [];
      if (o.secretField.length > 0 || o.totp.length > 0) {
        if (o.feature !== undefined || (strategy !== "goal" && strategy !== "usability")) {
          emitExplore(fail("E_EXPLORE_ARGS", "--secret-field and --totp are supported only with --strategy goal or usability"));
          return;
        }
        try {
          secretFields = [
            ...o.secretField.map((s) => parseSecretField(s, "value", process.env)),
            ...o.totp.map((s) => parseSecretField(s, "totp", process.env)),
          ];
        } catch (err) {
          if (!(err instanceof SecretFieldSpecError)) throw err;
          emitExplore(fail(err.code, err.message));
          return;
        }
      }

      // #281: fields typed with a file's exact text — read (and checked) before any browser opens.
      let typeFixtures: TypeFixture[] = [];
      if (o.typeFixture.length > 0) {
        if (o.feature !== undefined || strategy !== "goal") {
          emitExplore(fail("E_EXPLORE_ARGS", "--type-fixture is supported only with --strategy goal"));
          return;
        }
        try {
          typeFixtures = loadTypeFixtures(o.typeFixture);
        } catch (err) {
          if (!(err instanceof TypeFixtureSpecError)) throw err;
          emitExplore(fail(err.code, err.message));
          return;
        }
      }

      // Mission fixtures (#140/#144) run around the goal loop and its replays only.
      const fixtureFlagsGiven = o.fixtures !== undefined || o.before !== undefined || o.after !== undefined;
      if (fixtureFlagsGiven && (o.feature !== undefined || strategy !== "goal")) {
        emitExplore(fail("E_EXPLORE_ARGS", "--fixtures, --before and --after are supported only with --strategy goal, or with --from-journey (any anchored strategy)"));
        return;
      }

      // Additive coverage/exploratory strategy: proof-by-induction state coverage.
      // It takes no goal/success (the frontier itself is the objective), so it is
      // a distinct, goal-free path that leaves the goal strategy below unchanged.
      if (strategy === "coverage" || strategy === "exploratory") {
        if (!o.url) {
          emitExplore(fail("E_EXPLORE_ARGS", "--url is required"));
          return;
        }
        if (o.scope !== undefined && o.scope !== "app") {
          emitExplore(fail("E_EXPLORE_ARGS", `--scope must be "app" (got ${JSON.stringify(o.scope)})`));
          return;
        }
        const covAllowlist = resolveExploreAllowlist(o.url, o.allow);
        const covBounds: Record<string, number> = {};
        if (o.maxActions !== undefined) covBounds.maxActions = Number(o.maxActions);
        if (o.maxDecisions !== undefined) covBounds.maxDecisions = Number(o.maxDecisions);
        // Scope containment (#89, reusing #64's model): the start URL's route plus --route globs;
        // --scope app (or --route '/**') widens it to the whole app.
        const covRouteGlobs = [...o.route, ...(o.scope === "app" ? ["/**"] : [])];
        const covStall = stallTimeoutMs(o.stallTimeout);
        if (covStall === null) {
          emitExplore(fail("E_EXPLORE_ARGS", `--stall-timeout must be a positive number of seconds (got ${JSON.stringify(o.stallTimeout)})`));
          return;
        }

        let covJudge: JudgmentPort;
        let covGen: GenerationPort;
        let covUsage: UsageTracker;
        try {
          ({ judge: covJudge, gen: covGen, usage: covUsage } = await buildExploreGateways(deps, {
            real: o.real ?? false,
            fakeAi: o.fakeAi ?? false,
          }));
        } catch (err) {
          if (err instanceof MissingCredentialError || err instanceof GatewaySelectionError) {
            emitExplore(fail("E_AI_SETUP_REQUIRED", err.message));
          } else {
            emitExplore(fail("E_EXPLORE_SETUP", String(err instanceof Error ? err.message : err)));
          }
          return;
        }

        try {
          const result = await runCoverageMission({
            ...(target === undefined ? {} : { target }),
            ...(o.actionDeltas === true ? { actionDeltas: true } : {}),
            url: o.url,
            allowlist: covAllowlist,
            judge: covJudge,
            gen: covGen,
            usage: covUsage,
            bounds: Object.keys(covBounds).length > 0 ? covBounds : undefined,
            ...(covRouteGlobs.length > 0 ? { routeGlobs: covRouteGlobs } : {}),
            strategy,
            ...(covStall === undefined ? {} : { stallTimeoutMs: covStall }),
            outDir: o.out,
            browserPortFactory: deps.explore?.browserPortFactory,
            browser,
            ...screenshotsOpt,
            ...(emulation === undefined ? {} : { emulation }),
            overflow,
            ...(o.storageState !== undefined ? { storageState: o.storageState } : {}),
            ...(o.saveStorageState !== undefined ? { saveStorageState: o.saveStorageState } : {}),
            ...withInvariants,
            ...triagedServerLog(serverLog, covJudge, o.real === true),
            ...withPrefix,
          });
          // Typed verdict → exit code (0 clean · 1 defects · 2 crashed; see exit-codes.ts).
          emitExplore(ok(await withEvidence(result)), result.exitCode);
        } catch (err) {
          if (emitJourneyFailure(err)) return;
          if (err instanceof UnauthorizedExploreTargetError) {
            emitExplore(fail("E_UNAUTHORIZED_EXPLORE_TARGET", err.message));
          } else if (err instanceof ScopeUnderivableError) {
            // #224: no default route scope from --url — a usage error (64), refused before any browser.
            emitExplore(fail("E_EXPLORE_ARGS", err.message));
          } else {
            emitExplore(fail("E_EXPLORE_RUN", String(err instanceof Error ? err.message : err)));
          }
        }
        return;
      }

      // Additive adversarial strategy: a bounded "try to break it" run whose
      // stop decision comes from a trusted hard-signal oracle (never Jev's
      // Noul). Requires only --url; --goal/--success are goal-strategy inputs.
      if (strategy === "adversarial") {
        if (!o.url) {
          emitExplore(fail("E_EXPLORE_ARGS", "--url is required for --strategy adversarial"));
          return;
        }
        const advAllowlist = resolveExploreAllowlist(o.url, o.allow);
        let advJudge: JudgmentPort;
        let advGen: GenerationPort;
        let advUsage: UsageTracker;
        try {
          ({ judge: advJudge, gen: advGen, usage: advUsage } = await buildExploreGateways(deps, {
            real: o.real ?? false,
            fakeAi: o.fakeAi ?? false,
          }));
        } catch (err) {
          if (err instanceof MissingCredentialError || err instanceof GatewaySelectionError) {
            emitExplore(fail("E_AI_SETUP_REQUIRED", err.message));
          } else {
            emitExplore(fail("E_EXPLORE_SETUP", String(err instanceof Error ? err.message : err)));
          }
          return;
        }

        let coverageThresholds: CoverageThresholds;
        try {
          coverageThresholds = resolveCoverageThresholds({
            ...(o.minControlCoverage === undefined ? {} : { minControlRatio: Number(o.minControlCoverage) }),
            requireFormSubmit: o.requireFormSubmit,
          });
        } catch (err) {
          emitExplore(fail("E_EXPLORE_ARGS", String(err instanceof Error ? err.message : err)));
          return;
        }
        const advBounds: Record<string, number> = {};
        if (o.maxActions !== undefined) advBounds.maxActions = Number(o.maxActions);
        if (o.maxDecisions !== undefined) advBounds.maxDecisions = Number(o.maxDecisions);
        try {
          const result = await runAdversarialCliMission({
            ...(target === undefined ? {} : { target }),
            ...(o.actionDeltas === true ? { actionDeltas: true } : {}),
            seedUrl: o.url,
            allowlist: advAllowlist,
            usage: advUsage,
            ...(o.route.length > 0 ? { routeGlobs: o.route } : {}),
            coverageThresholds,
            bounds: Object.keys(advBounds).length > 0 ? advBounds : undefined,
            secrets: o.secret.length > 0 ? o.secret : undefined,
            ...(runFiling === undefined ? {} : { filing: runFiling }),
            issueFiler,
            ...(o.hangReplays === undefined ? {} : { hangReplays: o.hangReplays }),
            strategies: CLI_ADVERSARIAL_STRATEGIES,
            judgment: advJudge,
            generation: advGen,
            browserPortFactory: deps.explore?.browserPortFactory,
            browser,
            ...screenshotsOpt,
            ...(emulation === undefined ? {} : { emulation }),
            overflow,
            outDir: o.out,
            ...(o.storageState !== undefined ? { storageState: o.storageState } : {}),
            ...(o.saveStorageState !== undefined ? { saveStorageState: o.saveStorageState } : {}),
            ...withInvariants,
            ...triagedServerLog(serverLog, advJudge, o.real === true),
            ...withPrefix,
          });
          // The typed verdict gates CI: 0 clean · 1 defects found (a failing check) · 2 the run
          // itself broke (inconclusive/crashed) — see exit-codes.ts.
          emitExplore(ok(await withEvidence(result)), result.exitCode);
        } catch (err) {
          if (emitJourneyFailure(err)) return;
          if (err instanceof UnauthorizedExploreTargetError) {
            emitExplore(fail("E_UNAUTHORIZED_EXPLORE_TARGET", err.message));
          } else if (err instanceof ScopeUnderivableError) {
            // #224: no default route scope from --url — a usage error (64), refused before any browser.
            emitExplore(fail("E_EXPLORE_ARGS", err.message));
          } else {
            emitExplore(fail("E_EXPLORE_RUN", String(err instanceof Error ? err.message : err)));
          }
        }
        return;
      }

      // Additive: `--strategy usability` (issue #30) — a UX review. Reuses the
      // explore loop (goal = the job) and analyzes each observed screen against
      // the cited @jevitate/ux rubric. Findings are ADVISORY: a UX finding never
      // gates the run (no non-zero exit).
      if (strategy === "usability") {
        if (!o.url || !o.goal) {
          emitExplore(fail("E_EXPLORE_ARGS", "--url and --goal (the job) are required for --strategy usability"));
          return;
        }
        if (!o.appClass) {
          emitExplore(fail("E_UX_ARGS", "--app-class is required for --strategy usability"));
          return;
        }
        // #225: --success is never ignored — an independent completion check on the job, parsed and
        // validated exactly as for --strategy goal (same kinds, same --success-when / vacuous rules).
        let uxSuccessChecks: SuccessCheck[];
        try {
          uxSuccessChecks = o.success.map(parseSuccessSpec);
        } catch (err) {
          emitExplore(fail("E_EXPLORE_ASSERTION", String(err instanceof Error ? err.message : err)));
          return;
        }
        if (o.successWhen !== undefined && o.successWhen !== "held" && o.successWhen !== "final" && o.successWhen !== "each") {
          emitExplore(fail("E_EXPLORE_ARGS", `--success-when must be "final", "held" or "each", got ${JSON.stringify(o.successWhen)}`));
          return;
        }
        if (uxSuccessChecks.length === 0 && (o.successWhen !== undefined || o.allowVacuousChecks === true)) {
          emitExplore(fail("E_EXPLORE_ARGS", "--success-when and --allow-vacuous-checks need at least one --success check"));
          return;
        }
        const uxAllowlist = resolveExploreAllowlist(o.url, o.allow);
        const uxBounds: Record<string, number> = {};
        if (o.maxActions !== undefined) uxBounds.maxActions = Number(o.maxActions);
        if (o.maxDecisions !== undefined) uxBounds.maxDecisions = Number(o.maxDecisions);
        let uxJudge: JudgmentPort;
        let uxGen: GenerationPort;
        let uxUsage: UsageTracker;
        try {
          ({ judge: uxJudge, gen: uxGen, usage: uxUsage } = await buildExploreGateways(deps, {
            real: o.real ?? false,
            fakeAi: o.fakeAi ?? false,
          }));
        } catch (err) {
          if (err instanceof MissingCredentialError || err instanceof GatewaySelectionError) {
            emitExplore(fail("E_AI_SETUP_REQUIRED", err.message));
          } else {
            emitExplore(fail("E_EXPLORE_SETUP", String(err instanceof Error ? err.message : err)));
          }
          return;
        }
        try {
          const result = await runUsabilityMission({
            ...(target === undefined ? {} : { target }),
            url: o.url,
            job: o.goal,
            allowlist: uxAllowlist,
            appContext: { appClass: o.appClass, job: o.goal },
            judge: uxJudge,
            gen: uxGen,
            usage: uxUsage,
            ...(o.minConfidence !== undefined ? { minConfidence: o.minConfidence } : {}),
            ...(o.show !== undefined ? { show: o.show } : {}),
            ...(o.maxFindingsPerPage !== undefined ? { maxFindingsPerRoute: o.maxFindingsPerPage } : {}),
            ...(o.product !== undefined ? { product: o.product } : {}),
            ...(o.polish === true ? { polish: true } : {}),
            ...(o.probeGuards === true ? { probeGuards: true } : {}),
            bounds: Object.keys(uxBounds).length > 0 ? uxBounds : undefined,
            conversation,
            secrets: o.secret.length > 0 ? o.secret : undefined,
            ...(secretFields.length > 0 ? { secretFields } : {}),
            fixture: o.fixture,
            outDir: o.out,
            browserPortFactory: deps.explore?.browserPortFactory,
            browser,
            ...screenshotsOpt,
            ...(emulation === undefined ? {} : { emulation }),
            overflow,
            ...(o.storageState !== undefined ? { storageState: o.storageState } : {}),
            ...(o.saveStorageState !== undefined ? { saveStorageState: o.saveStorageState } : {}),
            ...triagedServerLog(serverLog, uxJudge, o.real === true),
            ...withInvariants,
            ...(uxSuccessChecks.length === 0 ? {} : { successChecks: uxSuccessChecks }),
            ...(o.successWhen === "held" || o.successWhen === "final" || o.successWhen === "each" ? { successWhen: o.successWhen } : {}),
            ...(o.allowVacuousChecks === true ? { allowVacuousChecks: true } : {}),
            ...withPrefix,
            ...(o.actionDeltas === true ? { actionDeltas: true } : {}),
          });
          // UX findings are advisory (0); a failed --success check (#225) is 1, as on a goal run; a
          // broken run or an unavailable analysis is 2.
          emitExplore(ok(await withEvidence(result)), result.exitCode);
        } catch (err) {
          if (emitJourneyFailure(err)) return;
          if (err instanceof UnauthorizedExploreTargetError) {
            emitExplore(fail("E_UNAUTHORIZED_EXPLORE_TARGET", err.message));
          } else if (err instanceof ScopeUnderivableError) {
            // #224: no default route scope from --url — a usage error (64), refused before any browser.
            emitExplore(fail("E_EXPLORE_ARGS", err.message));
          } else if (err instanceof FixtureNotFoundError) {
            emitExplore(fail("E_EXPLORE_FIXTURE", err.message));
          } else if (err instanceof MinConfidenceError || err instanceof QualityPolicyError || err instanceof MaxFindingsPerRouteError || err instanceof UxConfigError) {
            emitExplore(fail("E_UX_ARGS", err.message));
          } else if (err instanceof UsabilityInvariantsUnsupportedError) {
            emitExplore(fail("E_EXPLORE_ARGS", err.message));
          } else if (err instanceof ProductFactsError) {
            emitExplore(fail(err.code, err.message));
          } else {
            emitExplore(fail("E_EXPLORE_RUN", String(err instanceof Error ? err.message : err)));
          }
        }
        return;
      }

      // Additive: `--feature <name>` runs the capability-scoped feature-testing
      // mission (ticket #2 / site #11). It is model-free, so it needs neither
      // --goal/--success nor a gateway selection; the goal-based path below is
      // untouched when --feature is absent.
      if (o.feature) {
        if (!o.url) {
          emitExplore(fail("E_EXPLORE_ARGS", "--url is required with --feature"));
          return;
        }
        const featAllowlist = resolveExploreAllowlist(o.url, o.allow);
        const featBounds: Record<string, number> = {};
        if (o.maxActions !== undefined) featBounds.maxActions = Number(o.maxActions);
        if (o.maxDecisions !== undefined) featBounds.maxDecisions = Number(o.maxDecisions);
        const featStall = stallTimeoutMs(o.stallTimeout);
        if (featStall === null) {
          emitExplore(fail("E_EXPLORE_ARGS", `--stall-timeout must be a positive number of seconds (got ${JSON.stringify(o.stallTimeout)})`));
          return;
        }
        try {
          const result = await runFeatureCliMission({
            ...(featStall === undefined ? {} : { stallTimeoutMs: featStall }),
            seedUrl: o.url,
            allowlist: featAllowlist,
            capability: o.feature,
            routeGlobs: o.route ?? [],
            bounds: Object.keys(featBounds).length > 0 ? featBounds : undefined,
            outDir: o.out,
            browserPortFactory: deps.explore?.browserPortFactory,
            browser,
            ...screenshotsOpt,
            ...(emulation === undefined ? {} : { emulation }),
            ...(o.storageState !== undefined ? { storageState: o.storageState } : {}),
            ...(o.saveStorageState !== undefined ? { saveStorageState: o.saveStorageState } : {}),
            ...withInvariants,
            ...withServerLog,
            ...(target?.safety === undefined ? {} : { safety: target.safety }),
          });
          emitExplore(ok(await withEvidence(result)), result.exitCode);
        } catch (err) {
          if (err instanceof UnauthorizedExploreTargetError) {
            emitExplore(fail("E_UNAUTHORIZED_EXPLORE_TARGET", err.message));
          } else if (err instanceof ScopeUnderivableError) {
            // #224: no default route scope from --url — a usage error (64), refused before any browser.
            emitExplore(fail("E_EXPLORE_ARGS", err.message));
          } else {
            emitExplore(fail("E_EXPLORE_RUN", String(err instanceof Error ? err.message : err)));
          }
        }
        return;
      }

      // --success may be omitted for a find-out goal (#130d): the run is then verified by a grounded
      // `report` answer (#101) instead of an independent page/network check.
      if (!o.url || !o.goal) {
        emitExplore(fail("E_EXPLORE_ARGS", "--url and --goal are required"));
        return;
      }
      let successChecks: SuccessCheck[];
      try {
        successChecks = o.success.map(parseSuccessSpec);
      } catch (err) {
        emitExplore(fail("E_EXPLORE_ASSERTION", String(err instanceof Error ? err.message : err)));
        return;
      }
      if (o.successWhen !== undefined && o.successWhen !== "held" && o.successWhen !== "final" && o.successWhen !== "each") {
        emitExplore(fail("E_EXPLORE_ARGS", `--success-when must be "final", "held" or "each", got ${JSON.stringify(o.successWhen)}`));
        return;
      }
      const successWhen = o.successWhen === "held" || o.successWhen === "final" || o.successWhen === "each" ? o.successWhen : undefined;
      const allowlist = resolveExploreAllowlist(setupRefFreeUrl(o.url), o.allow);
      // Fixtures (#140/#144): the spec and every ${setup.x} reference are validated here, before any
      // browser or request; the setup itself runs just before the mission (below).
      let fx: MissionFixtures | undefined;
      try {
        checkUrlRefOrigin(o.url);
        fx = buildMissionFixtures(o, {
          allowlist,
          baseUrl: setupRefFreeUrl(o.url),
          ...(primaryStorageState === undefined ? {} : { storageState: primaryStorageState }),
          secretFields,
          secrets: o.secret,
          ...(target?.fixtures === undefined ? {} : { targetFixtures: target.fixtures }),
          ...(target?.personas === undefined ? {} : { personas: target.personas }),
        });
        checkSetupRefs({ "--url": o.url, "--goal": o.goal, "--success": o.success, ...invariantSetupTexts(invariants) }, fx);
      } catch (err) {
        if (!(err instanceof FixtureSpecError || err instanceof UnboundSetupRefError)) throw err;
        emitExplore(fail(err.code, err.message));
        return;
      }
      const bounds: Record<string, number> = {};
      if (o.maxActions !== undefined) bounds.maxActions = Number(o.maxActions);
      if (o.maxDecisions !== undefined) bounds.maxDecisions = Number(o.maxDecisions);

      let judge: JudgmentPort;
      let gen: GenerationPort;
      let usage: UsageTracker;
      try {
        ({ judge, gen, usage } = await buildExploreGateways(deps, { real: o.real ?? false, fakeAi: o.fakeAi ?? false }));
      } catch (err) {
        if (err instanceof MissingCredentialError || err instanceof GatewaySelectionError) {
          emitExplore(fail("E_AI_SETUP_REQUIRED", err.message));
        } else {
          emitExplore(fail("E_EXPLORE_SETUP", String(err instanceof Error ? err.message : err)));
        }
        return;
      }

      let url = o.url;
      let goal = o.goal;
      let runInvariants = withInvariants;
      if (fx !== undefined) {
        // Never run the mission on unknown state: a failed setup ends the run inconclusive (a
        // configuration error), after restoring whatever the partial setup created.
        try {
          await fx.setup();
          const b = fx.bindings();
          url = substituteUrlSetupRefs(o.url, b);
          goal = substituteSetupRefs(o.goal, b, { where: "--goal" });
          successChecks = o.success.map((spec) => parseSuccessSpec(substituteSetupRefs(spec, b, { where: "--success" })));
          // #187: ${setup.x} in the invariants (probe paths, deniedAs.open, capture routes), origin-fixed.
          if (invariants !== undefined) runInvariants = { ...withInvariants, invariants: substituteSpecSetupRefs(invariants, b, url) };
        } catch (err) {
          if (!(err instanceof FixtureSetupError || err instanceof UnboundSetupRefError)) {
            await fx.restore();
            throw err;
          }
          await fx.restore();
          emitExplore(ok(withEngine(fixtureSetupFailedResult(err, fx))), EXIT_CODES.inconclusive);
          return;
        }
      }
      try {
        const result = await runExploration({
            ...(target === undefined ? {} : { target }),
          url,
          goal,
          successChecks,
          ...(successWhen === undefined ? {} : { successWhen }),
          ...(o.allowVacuousChecks === true ? { allowVacuousChecks: true } : {}),
          ...(o.actionDeltas === true ? { actionDeltas: true } : {}),
          allowlist,
          judge,
          gen,
          usage,
          bounds: Object.keys(bounds).length > 0 ? bounds : undefined,
          secrets: o.secret.length > 0 ? o.secret : undefined,
          ...(secretFields.length > 0 ? { secretFields } : {}),
          ...(typeFixtures.length > 0 ? { typeFixtures } : {}),
          fixture: o.fixture,
          outDir: o.out,
          browserPortFactory: deps.explore?.browserPortFactory,
          browser,
          ...screenshotsOpt,
          ...(emulation === undefined ? {} : { emulation }),
          ...(primaryStorageState !== undefined ? { storageState: primaryStorageState } : {}),
          ...(o.saveStorageState !== undefined ? { saveStorageState: o.saveStorageState } : {}),
          ...(actors === null ? {} : { actors }),
          ...(runFiling === undefined ? {} : { filing: runFiling }),
          issueFiler,
          ...(o.hangReplays === undefined ? {} : { hangReplays: o.hangReplays }),
          conversation,
          ...runInvariants,
          ...triagedServerLog(serverLog, judge, o.real === true),
          ...(fx === undefined ? {} : { fixtures: fx }),
          ...withPrefix,
        });
        // 0 succeeded · 1 assertion not met · 2 the run broke (inconclusive/crashed).
        emitExplore(ok(await withEvidence(result)), result.exitCode);
      } catch (err) {
        if (emitJourneyFailure(err)) return;
        if (err instanceof UnauthorizedExploreTargetError) {
          emitExplore(fail("E_UNAUTHORIZED_EXPLORE_TARGET", err.message));
        } else if (err instanceof FixtureNotFoundError) {
          emitExplore(fail("E_EXPLORE_FIXTURE", err.message));
        } else {
          emitExplore(fail("E_EXPLORE_RUN", String(err instanceof Error ? err.message : err)));
        }
      } finally {
        // Every exit path restores the fixture state (a no-op when the mission already did).
        await fx?.restore();
      }
    });
}
