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
partial report (a usability review's observed screens). With `--json` the same result is printed
as the envelope before the process exits.

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
source that priced a call. `jevPriceSource` is a single string — just the Jev (judgment) price
source(s), joined with `" + "` — kept for compatibility with code written against the original
cost-reporting change; prefer `priceSource`, which covers generation calls too.

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

## Choosing the browser

Every command that opens a browser (`explore`, `explore-author-journey`, `journey run`, `load run`,
`regression capture`, `regression run`, `verify-fix`, `mission run`, `check`) takes the same launch
flags:

- `--browser-executable <path>` launches that Chromium binary instead of Playwright's pinned one.
- `--browser-channel <name>` launches a Playwright channel, e.g. `chrome` or `msedge`.
- `--browser-arg <arg>` (repeatable) adds a Chromium switch. It extends the Linux defaults
  `--no-sandbox --disable-dev-shm-usage`.

```bash
jevitate journey run checkout --browser-channel chrome --browser-arg=--lang=de
```

## How it's packaged

`@jevitate/cli` is a single bundled package — all internal `@jevitate/*`
workspace code is compiled into `dist/bin.js` via esbuild, and only native/heavy
dependencies (`playwright`, `better-sqlite3`, …) install alongside it. `jevitate`
is a thin bare-name wrapper that re-execs the same binary. Every other
`packages/*` is `private` and internal.
