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

Every exploration mission's result carries `usage` (a `--fake-ai` run reports the same shape with
zero tokens):

```text
usage: { judgments, generations, inputTokens, outputTokens,
         jevUsd?, generationUsd?, totalUsd?, priced: "full" | "partial" | "none", jevPriceSource? }
```

- `generationUsd` is filled ONLY when the provider itself reports a cost (OpenRouter's
  usage-accounting `cost` on a generation call). It is never estimated from a price table.
- `jevUsd`: Jev's SDK reports no per-call cost today, so judgments are priced only when you
  configure a unit price: `JEVITATE_JEV_UNIT_PRICE_USD` (env) or
  `{ "usage": { "jevUnitPriceUsd": 0.006 } }` in `~/.jevitate/config.json`. The result names
  the source in `jevPriceSource`. A malformed value is refused before the run starts.
- `totalUsd` is `jevUsd + generationUsd` whenever at least one is known, and `priced` says
  whether it is complete (`full`), missing a component (`partial`) or unknown (`none`).
  Read `priced` before you treat `totalUsd` as the run's real cost. An absent figure means
  "not priced by this build", never "free".
- `usd` is a deprecated alias for `totalUsd`.

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

## How it's packaged

`@jevitate/cli` is a single bundled package — all internal `@jevitate/*`
workspace code is compiled into `dist/bin.js` via esbuild, and only native/heavy
dependencies (`playwright`, `better-sqlite3`, …) install alongside it. `jevitate`
is a thin bare-name wrapper that re-execs the same binary. Every other
`packages/*` is `private` and internal.
