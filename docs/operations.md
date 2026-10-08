# Operations: build identity, usage, crashes and packaging

Operational details: which build produced a result, what a run cost, what happens when a run is killed or crashes, and how the CLI is packaged.

## Build identity

`jevitate --version` prints the published version, plus the commit and build time whenever
the build could determine them (`0.1.0 (commit d63c55b, built 2026-09-24T04:11:32.000Z)`) — a
plain version number alone doesn't change between rebuilds of an `npm link`ed working tree, so
two results from different builds in one dogfooding session were otherwise indistinguishable.
When they can't be determined (no `.git`, `git` unavailable), the field reads `unknown` —
never a fabricated commit or time.

The same `{version, commit, builtAt}` (as `engine`) is on every mission's result — the
persisted `*.result.json`, the `--json` envelope, and every issue draft's `## Environment`
section — so a result on disk always says which build produced it. So is every other command's
result envelope (`ux`, `journey run`, `load run`, `source run`, `verify-fix`, `regression capture`,
`mission run`), a killed run's partial result, `jevitate mcp`'s `initialize` (`serverInfo.version`,
with the commit in its description), MCP `get_site_health`, and `jevitate ui`'s `/api/health`.

A run killed by SIGTERM/SIGINT (`timeout -s TERM 900 jevitate explore …`) exits 143/130 and still
writes `<stem>.result.json`: `missionOutcome: "inconclusive"`, `stop: "terminated"`, the real step
count and transcript, the `transcriptPath` that exists, `engine`, the `usage` spent so far, and any
partial report (a usability review's observed screens). Before the process exits, the same result
is printed as the envelope with `--json`, or as the human summary without it. That holds from the
moment the run starts, while the browser is still launching (0 steps) included.

SIGHUP (a closed terminal, or one forwarded by the `jevitate` alias) is handled the same way and
exits 129. So is the death of the CLI's parent: if the process that started jevitate is killed
without forwarding a signal, jevitate notices within about a second and exits 129 with
`signal: "SIGHUP"`. Set `JEVITATE_PARENT_WATCHDOG=off` for a run you leave behind on purpose
(`nohup jevitate explore … &`). Before any of these exits, jevitate closes every browser it
launched. It sends each browser's process tree SIGTERM, waits up to 1 s, then sends SIGKILL, so a
signal sent only to the CLI's pid (Node's `spawnSync(…, { timeout })`, `kill <pid>`) leaves no
Chromium running.

## Usage accounting

Every result that made model calls carries `usage`: exploration missions (goal,
coverage, adversarial, usability), `ux`, a self-healing `journey run`,
`explore-author-journey`, `ai generate --real`, and a run killed by SIGTERM/SIGINT
(the calls it made before the signal).

```json
"usage": {
  "judgments": 398, "generations": 12,
  "inputTokens": 701200, "outputTokens": 3900,
  "jevUsd": 0.0294, "generationUsd": 0.0187, "totalUsd": 0.0481,
  "priced": "full",
  "priceSource": ["table:typesafe-models@2026-09-24 (https://docs.typesafe.ai/models.md)",
                  "provider:openrouter usage.cost"]
}
```

- `totalUsd` is `jevUsd + generationUsd`: the cost of every call that could be priced.
  Retries and failed attempts are counted as calls too.
- `priced` says whether that is everything. `full` means every call was priced. `partial`
  means at least one call could not be priced, and `missing` names it (for example
  `jev: no price for model jev-9.0.0`). `none` means nothing could be priced. A `partial`
  total is a lower bound, never the real cost, and a `check` `maxUsd` budget fails on it.
- `failedCalls` counts attempts that threw. A failed attempt that reported no token usage
  (an HTTP error, for example) is left unpriced, so it makes the total `partial`.

Each call is priced by the first of these that applies:

1. The cost the provider reported for that call (OpenRouter's usage-accounting `cost`).
2. For a Jev judgment, a configured price per judgment: `JEVITATE_JEV_UNIT_PRICE_USD` (env),
   or `usage.jevUnitPriceUsd` in `~/.jevitate/config.json`.
3. A configured price per million tokens for that model: `usage.modelPrices` in
   `~/.jevitate/config.json`.
4. The built-in, dated price tables. Jev comes from TypeSafe's
   [model page](https://docs.typesafe.ai/models.md), retrieved 2026-09-24: `jev-1.13.0`
   (and the `jev-latest` / `jev-preview` aliases) costs $0.042 per million input tokens,
   and output tokens are free. Generation comes from OpenRouter's model catalog, retrieved
   2026-09-24: `openai/gpt-4o-mini` costs $0.15 per million input tokens and $0.60 per
   million output tokens. Any other model is unpriced until you configure it.

```json
{ "usage": {
    "jevUnitPriceUsd": 0.00005,
    "modelPrices": {
      "jev-1.14.0":    { "inputUsdPerMtok": 0.042, "outputUsdPerMtok": 0 },
      "openai/gpt-4o": { "inputUsdPerMtok": 2.5,   "outputUsdPerMtok": 10 } } } }
```

A malformed price fails the run's setup; it is never ignored. `priceSource` lists every
source that priced a call, judgment and generation alike. (The 0.2.0 `jevPriceSource` and `usd`
aliases were removed in 0.3.0; read `priceSource` and `totalUsd`.)

Next to each result, `<run>.usage.json` lists every call: `seq`, `kind`
(`judgment`/`generation`), `task` (for example `form.value` or `chat.reply`), `model`,
`ok`, tokens, `usd` and its `source`, or `failure` (an error class such as `http-429`).
It never holds prompts, answers, error messages or credentials.

Totals across runs have the same fields, plus `runs` and `tokens`. They appear in the
`--repeat` / `--persona` multi-run result (a run that reported no usage makes the total
`partial`), in the `check` result, and in `jevitate report` (with a "Model cost"
section in the markdown). `explore` (including a multi-run), `ux`, `journey run` and
`explore-author-journey` print a one-line cost summary to stderr, so stdout stays the
JSON you parse. For example: `usage: cost $0.0481 (jev $0.0294 + generation $0.0187) ·
398 judgments, 12 generations, 705,100 tokens`. When the total is incomplete, it adds
`(partial: …)`.

## Crashes and issue drafts

Every crash records the steps up to it, the error and stack, the page/browser
crash signals and the page's JS heap per step. It is attributed from that
evidence: to jevitate (an own-code stack frame and no page/browser crash signal),
to the system under test (page or browser crash, renderer OOM, unbounded heap
growth, a hang), or as uncertain (filed to both). The host's own resource
pressure is sampled at detection time (the same sample admission control takes:
PSI, cgroup and meminfo on Linux/WSL, a portable fallback elsewhere) and is part
of the evidence. If the host was over a threshold, an unresponsive main thread
or a navigation timeout is attributed as uncertain ("host under resource
pressure"), not to the app. Each defect and crash gets a
ready-to-file, redacted Markdown draft in `<recording>.issues/<fingerprint>.md`.

Filing is off by default. It needs `--file-issues` (or `"enabled": true`) and a
repo: engine findings go to `--jevitate-repo` (default `matt-cochran/jevitate`);
findings in the app under test go to the repo configured for that target, with
`--issue-repo` or `~/.jevitate/filing.json`:

```json
{ "enabled": false, "targets": { "https://app.example.test": { "repo": "acme/app" } } }
```

Filing uses the `gh` CLI when it is installed, otherwise the GitHub REST API with
`GITHUB_TOKEN` from jevitate's credential store. Before it opens an issue, it
searches for an open issue carrying the same fingerprint marker and comments on
that one instead.

## Bounded runs: the page watchdog

A renderer that dies makes every pending browser operation fail at once, and the run ends
`crashed` with the crash evidence. A renderer that stays alive but stops answering (frozen,
starved on a loaded host, or wedged) is different: Playwright waits on it forever, and no
per-step bound in a mission can see it. Two bounds keep such a run from idling until something
kills it (#220), and a third bounds each click:

- **Page watchdog.** Every mission page is probed with a trivial evaluate every few seconds
  (every `min(5 s, limit / 3)`). A page that answers nothing for `JEVITATE_PAGE_UNRESPONSIVE_MS`
  milliseconds (default `60000`, 60 s) is closed with a reason. The run then ends through its
  crash path with `missionOutcome: "crashed"` (exit 2) and `failure.kind: "stalled"`, and
  `failure.message` says why: `the page process stopped responding: no answer for 60s (renderer
  frozen, starved or wedged); jevitate closed the page so the run ends instead of hanging`. It
  never becomes a hang finding. The value must be a positive integer; any other value is refused
  (`RangeError`) instead of silently meaning the default.
- **Opening a browser context or page** is bounded to 60 s (`DEFAULT_OPEN_TIMEOUT_MS`, not
  configurable). A browser that does not answer `newContext`/`newPage` in that time fails the
  session with "did not finish within 60000ms: the browser is not answering" instead of hanging it.
- **Click timeout.** The click an action performs (after the control passed its actionability
  check) is bounded by `JEVITATE_CLICK_TIMEOUT_MS` milliseconds (default `5000`). In coverage and
  exploratory runs a click that timed out is retried once before it counts as a failed action; a
  frontier that ended because its actions kept timing out says so and names this variable. Raise it
  (for example `JEVITATE_CLICK_TIMEOUT_MS=15000`) for an app whose controls are slow to respond or a
  loaded CI runner. Like `JEVITATE_PAGE_UNRESPONSIVE_MS`, a value that is not a positive integer is
  refused when the CLI starts (`error E_CLI_ENV: …`, exit 64) — a typo never silently means the
  default (#213).

Raise `JEVITATE_PAGE_UNRESPONSIVE_MS` only when a page legitimately blocks its main thread for
more than 60 s at a time (a very heavy synchronous computation, or a slow emulated device on a
slow CI runner), for example `JEVITATE_PAGE_UNRESPONSIVE_MS=180000`. If runs end `stalled` on a
busy machine, first check the result's `hostHealth` (see [outcomes](./outcomes.md#a-starved-host-hosthealth-environmentdegraded)):
a starved host is better fixed by running fewer missions at once than by a longer bound. An app
whose server stops answering navigation is not this case: that ends `inconclusive` with
`failure.kind: "target-unresponsive"` ([outcomes](./outcomes.md#an-app-that-stops-answering-target-unresponsive)).

## Shared machines: resource governance

jevitate often runs next to builds, test suites, dev servers and other agents. A browser run that
competes with them for memory and CPU times out (and reads as the app hanging), or gets something
else killed. One governor per jevitate process applies four rules (#205); what each did is
recorded in every mission result (every explore strategy) under `hostHealth.resources`.

**Machine-wide browser cap.** At most `--max-browsers` jevitate processes have a browser open at
once, across every jevitate on the machine: other terminals, agents, CI jobs and other projects'
checks. A process takes one slot while it has any browser session open. A second context the same
run opens, such as an observer actor or a hang replay, shares the slot, so a run never waits on
itself. The default is `JEVITATE_MAX_BROWSERS`, else a quarter of the cores, at least 2 and at most
6, and no more than one per 2 GiB of RAM (4 on a 16-core, 24 GiB machine). Slots are files under
`~/.jevitate/run/browser-slots/`, created exclusively. A slot is stale when its holder on this host
is no longer running, or when it has sent no heartbeat (the file's mtime, refreshed every 20 s)
for 3 minutes. A stale slot is reclaimed by the next run that needs it. A run that waits longer
than the admission timeout (`JEVITATE_ADMISSION_TIMEOUT_MS`, default 5 min) fails with a message
naming the processes that hold the slots. Within one process, the browser pool's own context cap
(`JEVITATE_BROWSER_MAX_CONTEXTS`) still applies.

**Memory ceiling.** The memory of the browsers a run launched (browser, renderers and helper
processes, summed as Linux PSS, or RSS on macOS) is sampled every 2 s. Past the ceiling, the
session's page is closed with a reason, and the run ends `inconclusive` (exit 2) with
`failure.kind: "resource-limit"`. The message names the measured value and the ceiling:
`resource limit: this run's browser processes used 837 MiB (pss of 6 processes), over the 768 MiB
memory ceiling …`. It is never `crashed`, never a defect or hang, and never attributed to the app. Other
browser commands (`journey run`, `verify-fix`, regression replay) stop at the step that was running
when the page closed; the reason is printed on stderr as a process warning.
The ceiling is `--max-browser-memory <MiB>`, else `JEVITATE_MAX_BROWSER_MEMORY_MB` (`off` disables
it), else 4 GiB or half the RAM, whichever is less. A process that runs several sessions at once is
measured as a whole; when it goes over, the session whose page holds the most JS heap is ended.
Windows has no supported process reader, so there the ceiling is not enforced and
`hostHealth.resources.memoryMeasurement` is `unavailable`.

**Adaptive throttling.** The host is judged when a session starts and on every sample:

| level | when | effect |
| --- | --- | --- |
| `normal` | otherwise | none |
| `throttled` | load above 2 per core, under 1.5 GiB available, or memory pressure (PSI full avg10) above 5% | a new run may take only half the machine cap (at least 1); default settle windows (quiet window, render ceiling) are doubled |
| `starved` | load of 4 per core or more, or under 512 MiB available | a NEW run refuses to start with `E_HOST_STARVED` (exit 2); a run already going keeps going, throttled |

`--ignore-host-load` starts a run on a starved host anyway. The run is throttled and its result
records it. `hostHealth.resources.throttle` gives the most severe level seen and why, and
`throttleChanges` lists each level change with its time. This complements starved-host
attribution ([outcomes](./outcomes.md#a-starved-host-hosthealth-environmentdegraded)): throttling
avoids the timeouts, and attribution explains the ones that still happen.

**Orphan cleanup.** Every Chromium that jevitate launches carries a marker switch,
`--jevitate-owner=<pid>@<start>`, that names the jevitate process that launched it and that
process's start time. A browser left behind by a killed jevitate (`kill -9`, a crashed CI job) is
an orphan: its owner pid is not running, or the pid now belongs to another process. Before every
browser-driving command, once per process, jevitate closes such orphans (SIGTERM, then SIGKILL
after 2 s) and clears stale slots. Only marked processes are candidates; nothing jevitate did not
launch is ever signalled. `jevitate doctor` shows the host's level, the machine slots and their
holders, and the jevitate browsers and orphans. `jevitate doctor --cleanup` closes the orphans and
clears the stale slots on demand. On a normal exit, including SIGTERM, SIGINT, SIGHUP and the
parent's death, browsers are closed and slots released as before.

`JEVITATE_RESOURCE_GOVERNANCE=off` turns off the automatic parts: the default cap and ceiling,
throttling, the starved-host refusal and the startup sweep. An explicit `--max-browsers` or
`--max-browser-memory` still applies. jevitate's own test suite sets it. Every variable is checked
when the CLI starts; a value that is not valid is refused with `E_CLI_ENV` (exit 64). The MCP tools
that launch a browser take `maxBrowsers` and `maxBrowserMemory`. `--ignore-host-load` is the
operator's call and is not an MCP argument.

## Where jevitate keeps things

`jevitate init` creates the app repo's own `.jevitate/` at the git root. Commands find it by
walking up from the working directory.

| In the repo's `.jevitate/` (committed) | In `~/.jevitate/` (per user, never in a repo) |
| --- | --- |
| `journeys/`: named Journeys; shared ones as git submodules under `journeys/<shared>/` | `credentials.json`, `config.json`, `targets.json` |
| `regressions/`: committed regression artifacts | `profiles/`, browser storage states, the site-policy `db.sqlite` |
| `baselines/`: `baseline tag` snapshots | `inbox/`, `missions/` (the queue), `trust/`, `sources/` (clones) |
| `environments.json`: named environments for `--env` ([journeys](./journeys.md#environments---env)) | per-environment sessions and secret fields, in `targets.json` by origin |
| `logs/<date>/`: run output (not committed) | `journeys/` and `logs/` when you are not in a repo |
| | `run/browser-slots/`: the machine-wide browser slots ([resource governance](#shared-machines-resource-governance)) |

`.jevitate/.gitignore` (written by `init`, which only ever adds the lines it lacks) keeps `logs/`
and unapproved Journey annotation drafts (`journeys/.drafts/`) and the Jev answer cache (`cache/`, answers keyed by content hash) out of git, along with any secret or machine-local file that might be copied there: credentials,
config, targets, the policy database, profiles and storage states, the inbox and queue, trust
decisions, source clones, `.env` files, HAR captures and traces.

Run output goes to `logs/<UTC date>/`, named by its artifact stem
(`explore-2026-09-25T01-26-29-787Z.result.json`). `get_mission_result`, `verify_fix` and
`report` find a result by its id in the project's logs, then in `~/.jevitate/logs`, then in the
0.1.0 `~/.jevitate/recordings` and `~/.jevitate/ux-reports`.

Logs are pruned at the start of every command that writes them: a run older than 14 days is
deleted, but the newest 50 runs are always kept. Change it in `~/.jevitate/config.json`:

```json
{ "logs": { "ttlDays": 30, "keepLatest": 100 } }
```

`jevitate logs prune [--dry-run] [--dir <logs>]` runs it on demand.

## Choosing the browser

Every command that opens a browser (`explore`, `explore-author-journey`, `journey run`, `source run`,
`load run`, `regression capture`, `regression run`, `verify-fix`, `mission run`, `check`) takes the same launch
flags:

- `--browser-executable <path>` launches that Chromium binary instead of Playwright's pinned one.
- `--browser-channel <name>` launches a Playwright channel, e.g. `chrome` or `msedge`.
- `--browser-arg <arg>` (repeatable) adds a Chromium switch. It extends the Linux defaults
  `--no-sandbox --disable-dev-shm-usage`.

```bash
jevitate journey run checkout --browser-channel chrome --browser-arg=--lang=de
```

## Demo mode: watching a run

Headless is the default everywhere, `check` and CI included; demo mode is opt-in (#245). The flags
are resolved in one place (`packages/cli/src/browser-run-options.ts`), so every browser a run opens
— the mission's own, hang-replay sessions, `--actor` observers, verify-fix replays — is shown and
recorded the same way.

| Flag | What it does | Commands |
| --- | --- | --- |
| `--headed` / `JEVITATE_HEADED=1` | A visible Chromium window | `explore` (every strategy), `journey run`, `journey demo`, `demo`, `demo approve`, `verify-fix`, `regression capture`, `regression run` |
| `--slow-mo <ms>` | Playwright `slowMo`: each browser operation is delayed this long. A non-negative integer (else exit 64). With `--headed` and no `--slow-mo`: 250 | the same |
| `--record-video [dir]` | A Playwright video of each browser context. Works headless too | `explore`, `journey run`, `verify-fix` |
| `--no-overlay` | With `--headed`: hide the on-page overlay (step, intent, target highlight, outcome banner) | `explore` |
| `--screenshots [mode\|dir]` | Masked screenshots + an `index.md` contact sheet (#251) | `explore`, `journey run\|annotate\|demo`, `verify-fix` |
| `--evidence-video` | Per defect: a captioned repro clip + before/at screenshots (#250) | `explore` (a `check` item: `evidenceVideo`) |

- **Videos.** A run's videos go in its own folder, `<run>.videos/`, next to the run's result (or
  under `--record-video <dir>`): `explore-<stamp>.videos/`, `usability-<stamp>.videos/`,
  `verify-fix-<stamp>.videos/` beside the mission result, `journey-<id>-<stamp>.videos/` in the logs
  dir. The run closes its browser contexts before it writes its result, so every listed video is
  complete. The paths are in the result as `videoPaths` (an additive field of the unified result
  schema, `schemaVersion` 1) and in the human summary as `VIDEO` lines. A run killed by
  SIGINT/SIGTERM lists the files already there, but cannot wait for a context to close, so its last
  video may be truncated.
- **No display.** `--headed` needs one: on Linux, with neither `DISPLAY` nor `WAYLAND_DISPLAY` set
  (WSL2 without WSLg, a CI container), the command is refused before any browser launches —
  `error E_EXPLORE_ARGS: --headed needs a display …` (exit 64) — and suggests `--record-video`.
- **Several windows.** `--repeat`, `--persona` and `--actor` runs open more than one browser; with
  `--headed` each is shown and a one-line warning is printed on stderr. Nothing is refused.
- **Never headed:** `mission run` (what MCP `queue_exploration` feeds) runs unattended and takes no
  demo flags; `load run` and `source run` stay headless too. In a `check` suite an item opts in with
  its own `headed`/`slowMo`/`recordVideo`/`overlay` options (see [CI](ci.md)).

## Evidence clips and screenshots

- **Defect evidence (`--evidence-video`, #250).** After the run, each defect's minimal repro
  Recording — the one `verify-fix` replays — is replayed in a fresh session with the overlay and a
  video. Every step is captioned (its objective, else its label, else a value-free description);
  the failing step is marked with the actual signal (`Save → server returned 500 (PUT /api/profile)`,
  `invariant \`x\` violated`, a console error, an overflow…) and whether this replay saw it fire again.
  Two screenshots — just before the failing step and at it, the failing element highlighted — have
  the overlay hidden. Files: `<run>.evidence/<fingerprint>/{clip.webm,before-step-N.png,at-step-N.png}`
  beside the result; the result gets `defects[].evidence.{videoPath, screenshots[], failingStep,
  signal, reproduced}` (additive, `schemaVersion` 1), the human summary `CLIP`/`SHOT` lines, the issue
  draft a "Repro clip and screenshots" section, and `report` / `check` (JUnit `attachment`
  properties + `[[ATTACHMENT|…]]`, SARIF `attachments` and `relatedLocations`) link them. At most 5
  defects per run get a clip (hard ones first). A run with mission fixtures or cross-actor observers
  is not replayed here (`skipped` says why): use `verify-fix --record-video`, which restores them.
  In `check`, an item that records video (`recordVideo`) gets evidence by default
  (`evidenceVideo: false` turns it off).
- **Before/after (`verify-fix --record-video`).** `evidence.before` is the run's own clip of the
  defect (when the run had `--evidence-video`), `evidence.after` a captioned replay of the same steps
  now, ending on the verdict.
- **Screenshots (`--screenshots`, #251).** `screens` (default): one per distinct screen,
  deduplicated by the page-state fingerprint coverage uses (url template + control table; a typed
  value is not a new screen); `steps`: one per step. `screens:<dir>`, `steps:<dir>` or `<dir>` pick
  the folder (default `<run>.screenshots/` beside the result). Each image is the viewport after the
  step acted, overlay hidden. `index.md` lists each image with its step, route and what happened.
  The result lists `screenshotPaths`, `screenshotIndex` and, when a capture was refused,
  `screenshotsSkipped` (additive). A `check` item takes `screenshots` with the same values.
- **Secrets are masked in pixels.** Every registered secret (`--secret`, secret fields, a Journey's
  secret parameters) shown on the page — in a text node, a non-password field's value, or an
  attribute such as `title` — is painted over by a display-only layer: a closed-shadow-root host on
  `<html>` (the overlay's technique; the page's own DOM is never changed) that re-measures before
  every paint, so video frames are covered too. Before and after every screenshot, and at every step
  of a clip, the mask is proven (each occurrence under a painted box, the layer attached, visible,
  on top). **Fail closed:** a screenshot that cannot be proven is not written (`screenshotsSkipped` /
  `captureSkips` say why); a clip whose mask failed at any step is deleted. Not covered: a secret
  drawn on a canvas, inside a closed shadow root, or under a modal/popover/fullscreen top layer
  (the last is detected and refused).
- **GitHub issues.** GitHub's API cannot upload media. Drafts and filed issues *link* to the files:
  commit them under the repo's `.jevitate/` or publish them as CI artifacts and link those. With
  `--evidence-video --file-issues`, drafts are filed after their media is attached.

## How it's packaged

`@jevitate/cli` is a single bundled package — all internal `@jevitate/*`
workspace code is compiled into `dist/bin.js` via esbuild, and only native/heavy
dependencies (`playwright`, `better-sqlite3`, …) install alongside it. `jevitate`
is a thin bare-name wrapper that re-execs the same binary. Every other
`packages/*` is `private` and internal.
