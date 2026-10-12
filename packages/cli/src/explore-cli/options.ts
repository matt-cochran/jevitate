import { JEV_PROVIDER_FLAG_HELP, jevProviderArg } from "../cli-shared.js";
import { TAG_FLAG, TAG_HELP, TARGET_FLAG, TARGET_HELP, collectTag } from "../run-tags-cli.js";
import { Command } from "commander";
import { ok, fail } from "../envelope.js";
import { withFixtureFlags } from "../fixture-cli.js";
import { positiveNumberArg, nonNegativeIntArg, positiveIntArg, ratioArg } from "../cli-args.js";
import { withBrowserLaunchFlags, withDemoFlags, withScreenshotsFlag, withEmulationFlags, collectParam, EXPLORE_OUTCOME_HELP } from "../cli-shared.js";
import { withEnvironmentFlags } from "../environments.js";
import { GOAL_RUN_OPTIONS } from "../goal-run-flags.js";

/** The `jevitate explore` command and every flag it takes (moved verbatim out of registerExploreCommands). */
export function declareExploreCommand(program: Command): Command {
  return withEnvironmentFlags(withScreenshotsFlag(withEmulationFlags(
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
    .option(TARGET_FLAG, TARGET_HELP)
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
    .addOption(GOAL_RUN_OPTIONS.successWhen())
    .addOption(GOAL_RUN_OPTIONS.allowVacuousChecks())
    .addOption(GOAL_RUN_OPTIONS.actionDeltas())
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
    .addOption(GOAL_RUN_OPTIONS.secret())
    .addOption(GOAL_RUN_OPTIONS.secretField())
    .addOption(GOAL_RUN_OPTIONS.totp())
    .addOption(GOAL_RUN_OPTIONS.typeFixture())
    .addOption(GOAL_RUN_OPTIONS.fixture())
    .option(
      "--storage-state <file>",
      "Playwright storageState JSON to start the session authenticated (deterministic login pre-step); must exist",
    )
    .option(
      "--auth-check <mode>",
      "#427 pre-flight auth check before a run that starts from a session (--storage-state, --persona/--personas, --actor's primary): " +
        "load the session, open --url and end the run fast (inconclusive, failure.kind auth-expired, exit 2) when it lands on a sign-in page — the login page is never explored. " +
        "auto (default): a login-like URL (/login, /signin, /sign-in, /auth, …) or a visible password field, unless --url is itself such a route; " +
        "urlExcludes:<text>: expired when the landed URL includes <text>; selector:<css>: alive only when this signed-in marker is visible; off. " +
        "A persona with login parameters (a personas file entry's `login`, or .jevitate/personas.json) is signed in again once instead",
    )
    .option(
      "--actor <name=storageState>",
      "multi-actor mission (#147, goal only; repeatable): the FIRST actor is the primary (the only one the model drives, " +
        "from its own storageState); every other actor is an observer in its OWN fresh context that only runs the " +
        "--invariants' cross-actor checks (capture + probe as:/deniedAs) — never clicks or types. Replaces --storage-state",
      (v: string, prev: string[]) => [...prev, v],
      [] as string[],
    )
    .addOption(GOAL_RUN_OPTIONS.saveStorageState())
    .option("--max-actions <n>", "hard cap on executed actions", positiveIntArg)
    .option("--max-decisions <n>", "hard cap on model decisions", positiveIntArg)
    .option(
      "--min-actions <n>",
      "--strategy goal (#424): the minimum actions before the model may conclude — until then an early report, blocked or answerless done is deferred and the run steered to breadth " +
        "(unvisited tabs, detail views, primary forms). Default: 12 (at most half the budget) for an open-ended find-out goal (no --success; \"the main features\", \"what works\", \"every error\", \"explore\"…), none otherwise. Capped by --max-actions (with a warning)",
      positiveIntArg,
    )
    .option(
      "--min-distinct-states <n>",
      "--strategy goal (#424): the minimum distinct page states (URL + visible controls) observed before the model may conclude. Default: 5 (scaled to the budget) for an open-ended find-out goal, none otherwise. Capped by the budget (with a warning)",
      positiveIntArg,
    )
    .option(
      "--stall-timeout <seconds>",
      "--strategy coverage/exploratory and --feature: end the run inconclusive (stalled) when no step completes within this many seconds (default 120)",
      positiveNumberArg,
    )
    .addOption(GOAL_RUN_OPTIONS.replyWaitMs())
    .addOption(GOAL_RUN_OPTIONS.replyQuietMs())
    .addOption(GOAL_RUN_OPTIONS.replyCeilingMs())
    .addOption(GOAL_RUN_OPTIONS.replyMaxChars())
    .addOption(GOAL_RUN_OPTIONS.jobWaitMs())
    .addOption(GOAL_RUN_OPTIONS.deny())
    .addOption(GOAL_RUN_OPTIONS.paid())
    .addOption(GOAL_RUN_OPTIONS.allowControl())
    .addOption(GOAL_RUN_OPTIONS.allowDestructive())
    .addOption(GOAL_RUN_OPTIONS.dialogs())
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
    .addOption(GOAL_RUN_OPTIONS.readRpc())
    .option("--real", "use live Jev + OpenRouter gateways (requires keys)", false)
    .option("--fake-ai", "use deterministic fake gateways (pipeline smoke only)", false)
    .option("--jev-provider <provider>", JEV_PROVIDER_FLAG_HELP, jevProviderArg)
    .option("--out <dir>", "directory to write the emitted Recording")
    .option(
      "--file-issues",
      "file findings as issues (needs a repo: --issue-repo or ~/.jevitate/filing.json); default: drafts only",
    )
    .option("--issue-repo <owner/name>", "the system-under-test repo findings for THIS target are filed to")
    .addOption(GOAL_RUN_OPTIONS.hangReplays())
    .option(
      "--hang-replay-writes",
      "let hang replays re-send a paid/destructive write the run sent (default: such a hang is reported inconclusive, never replayed)",
    )
    .addOption(GOAL_RUN_OPTIONS.settleIgnore())
    .addOption(GOAL_RUN_OPTIONS.longPollMs())
    .addOption(GOAL_RUN_OPTIONS.apiPrefix())
    .addOption(GOAL_RUN_OPTIONS.ignoreNoProgress())
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
    .addOption(GOAL_RUN_OPTIONS.allowSecretCmd())
    .addOption(GOAL_RUN_OPTIONS.secretCmdAttempts())
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
      "compatibility only since 0.8.0 (#420): a --log-source that opens and reads zero lines is now always a healthy oracle (the silence is recorded as serverLogs.quietSources), so this flag no longer changes any outcome. Kept so existing invocations keep working",
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
    .option(
      "--personas <file>",
      "personas JSON: {\"<name>\": \"<storageState>\"} or {\"personas\": [{\"name\", \"storageState\", \"login\"?}]} — #427: `login` " +
        "({url, userEnv, passwordEnv, userField?, passwordField?, submit?, success?}, or #449 {api, userEnv, passwordEnv} for an HTTP sign-in endpoint; environment variable NAMES only) re-mints an expired session once. " +
        "A bare --persona <name> is the project's persona of that name (.jevitate/personas.json, same format)",
    )
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
    .option(TAG_FLAG, TAG_HELP, collectTag, []);
}
