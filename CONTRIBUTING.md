# Contributing to Jevitate

Thanks for your interest in Jevitate. This guide covers how to report problems, how to set up
the repository, and the few conventions that keep the project consistent.

## Report a bug or ask for a feature

- **Bug:** open a [bug report](https://github.com/matt-cochran/jevitate/issues/new?template=bug_report.md).
  The most useful reports include the exact command, `jevitate --version` (it prints the commit
  and build time), the run's `outcome`/`reason`, and the paths of the `*.result.json` and
  `*.transcript.json` it wrote. Redact secrets and app data.
- **Feature:** open a [feature request](https://github.com/matt-cochran/jevitate/issues/new?template=feature_request.md)
  that describes the job to be done. What were you trying to test, and what got in the way?
- **Security issue:** never in a public issue. See [SECURITY.md](./SECURITY.md).

## Development setup

Jevitate is a pnpm workspace (Node 20 or later, pnpm 9).

```bash
pnpm install
pnpm -r build                                          # TypeScript project references
pnpm --filter @jevitate/cli exec playwright install chromium
pnpm lint                                              # eslint
pnpm check:no-fallback                                 # the no-permissive-fallback gate
```

Run the CLI you built with `node packages/cli/dist/bin.js <command>`. After
`pnpm --filter @jevitate/cli run bundle`, that file is the same single-file bundle npm ships.

### Running tests

Run tests by path, from the repository root:

```bash
pnpm exec vitest run packages/explore/src/success-checks.test.ts   # one file
pnpm exec vitest run packages/regression/src                       # one package
```

- Don't use `pnpm --filter <pkg> exec vitest`. It breaks the root include globs, and packages have
  no `test` script.
- The full suite (`pnpm exec vitest run`) is what CI runs on Linux. It starts real Chromium
  instances, so it is slow, and on WSL it can hang. Prefer path-scoped runs locally.

#### Time in tests

Node-side code never reads the wall clock or schedules a timer directly. It uses `clock` from
`@jevitate/domain` (`packages/domain/src/clock.ts`): `clock.now()`, `clock.nowIso()`,
`clock.monotonicMs()`, `clock.setTimeout`/`clearTimeout`/`setInterval`/`clearInterval` and
`clock.sleep(ms)`. By default these are the real platform timers. `pnpm lint` runs
`scripts/check-clock.mjs`, which rejects a new `Date.now()`, `new Date()`, `performance.now()`,
global timer or `page.waitForTimeout` in package source. Code that runs inside the browser (a
function passed to `evaluate` or `addInitScript`, or a declaration documented `BROWSER CODE`) keeps
the page's own timers.

- **Unit tests:** `installClock(new FakeClock())`, then move time explicitly with `advanceBy(ms)`,
  `next()` or `runUntilIdle()`. Pending sleeps and timeouts resolve in order, and awaited work runs
  between them. Call `resetClock()` afterwards.
- **Real-browser tests:** call `useSkippingTime()` from the explore testkit in the suite. It installs
  a `TimeSkippingClock` and drives every opened page's `page.clock` with it. Time flows normally
  while anything is happening. When the process is only waiting (a settle window on a quiet page, a
  hang ceiling over a held request, a documented wait), time jumps to the next timer. A browser call
  or a young request in flight blocks the jump. Use `{ pageClock: false }` for a page that spins on
  `Date.now()`, and `{ per: "all" }` when a `beforeAll` opens a shared session.
- **Real-time smoke tests:** some behaviour only exists in real time: a truly frozen renderer under
  the watchdog, a server that really holds a request open, real launch and teardown. Those tests keep
  the real clock with their thresholds scaled down (for example `JEVITATE_PAGE_UNRESPONSIVE_MS`), and
  their `describe` name starts with `[realtime]`. Keep that set small.
- The codemod that moved the code base onto the clock is `scripts/codemods/inject-clock.mjs`
  (`--dry-run` prints the plan).

### The example app

`apps/example-site` is the fixture app the end-to-end tests and the [demo](./docs/demo.md) run
against. Each fixture lives under its own route prefix (`/adversarial/*`, `/coverage-scope/*`,
`/editor-fixture`, `/tenancy/*`, `/demo/*`, …). To serve it on `http://127.0.0.1:5190`:

```bash
pnpm --filter @jevitate/example-site build
pnpm --filter @jevitate/example-site demo
```

## Find something to work on

- Newcomer-sized issues get the [`good first issue`](https://github.com/matt-cochran/jevitate/labels/good%20first%20issue)
  or [`help wanted`](https://github.com/matt-cochran/jevitate/labels/help%20wanted) label.
- Docs are a good first contribution. Every command in `README.md` and `docs/` must exist in
  `jevitate <command> --help`. If you find one that doesn't, that's a bug worth a PR.
- A new planted-bug fixture in `apps/example-site` (with a test) makes a new oracle or mission
  behaviour demonstrable.

## Branching

Work on a feature branch off `dev` and open a pull request into `dev`
(`dev → staging → main`). CI runs on `dev`, `staging` and `main`. PRs are squash-merged, so the
PR title and description become the commit message. Write them for the changelog.

## Conventions

- **Test-driven.** Add a failing test first, then the minimal code to pass it.
  Prefer small, declarative assertions.
- **Additive changes.** Extend existing commands and APIs rather than changing their
  behaviour, and keep new work behind new surfaces.
- **Fail fast, no silent fallbacks.** Refuse with an actionable error rather than
  papering over a problem. `scripts/check-no-permissive-fallback.mjs` runs in CI
  and must stay clean.
- **Security invariants are load-bearing** (see [SECURITY.md](./SECURITY.md)):
  credentials and secrets never reach a model, browsing is restricted to authorized
  origins, exploration is bounded, and model judgments are advisory and never
  unilaterally gate an action. Every guardrail has an "asserts-it-refuses" test.
  Keep it that way. The MCP tool allowlist in `packages/mcp-facade` is especially
  sensitive: the served tools must equal `ALLOWED_TOOLS`.
- **Honest outcomes.** A run that could not do its work is `inconclusive`, never `clean`.
  Don't add a path that reports success without evidence.
- **User-facing changes get a changeset** (`pnpm changeset`, bumping `@jevitate/cli` and
  `jevitate`) and a line in [CHANGELOG.md](./CHANGELOG.md).

## Pull requests

Keep PRs focused and include tests. Before you open one, make sure `pnpm -r build`, the tests
for the packages you touched, `pnpm lint` and `pnpm check:no-fallback` pass. CI runs the full
suite, the lint and the no-permissive-fallback gate, plus a cross-platform browser-pool smoke on
Linux, Windows and macOS.

## Releases

Publishing is maintainer-only. See [RELEASING.md](./RELEASING.md).
