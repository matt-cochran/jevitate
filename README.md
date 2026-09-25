# Jevitate

**Autonomous browser testing that turns discovered bugs into deterministic regression tests.**

[![CI](https://github.com/matt-cochran/jevitate/actions/workflows/ci.yml/badge.svg)](https://github.com/matt-cochran/jevitate/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@jevitate/cli.svg)](https://www.npmjs.com/package/@jevitate/cli)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

[Website](https://jevitate.com) · [Docs](./docs/README.md) · [Demo](./docs/demo.md) · [Changelog](./CHANGELOG.md)

Jevitate explores your web app in a real browser, tries to break it, and reports only what the
browser can prove: HTTP 5xx responses, uncaught exceptions, hangs, failed success checks, broken
rules you declare. Each defect comes with a Recording that reproduces it. Jevitate replays it to
confirm a fix and commits it as a regression you can run in CI.

**Nondeterministic discovery. Deterministic verification.** A model may suggest what to try next.
It never decides whether your software passed.

<!-- DEMO: replace this block with the recording once it exists (see docs/demo.md, "Recording the launch GIF or video"):
<p align="center"><img src="docs/assets/demo.gif" alt="Jevitate finds an HTTP 500 behind a form that says Saved, reproduces it, commits a regression, and verifies the fix" width="800"></p>
-->
> **Demo:** a 2-minute, no-API-key walkthrough is in [docs/demo.md](./docs/demo.md). A form says
> "Saved" while the server returns HTTP 500. Jevitate finds it, reproduces it 3/3, commits it as a
> regression, and verifies the fix.

## From "write a test" to "find the test you didn't write"

```text
Traditional E2E:  you write a test ──► it runs ──► it catches the failures you anticipated

Jevitate:         explore ──► detect (evidence) ──► reproduce ──► commit a regression ──► verify the fix
                  (goal, adversarial,   (code-decided   (replay in     (regression capture)   (verify-fix,
                   coverage, feature)    oracles)        fresh contexts)                        regression run)
```

Jevitate doesn't replace the E2E tests you write. It finds the failures nobody wrote a test for,
and hands each one back as a deterministic artifact.

## Quick start

Needs Node.js 20+. This first run needs **no API keys**: the adversarial mission plans its misuse
in code.

```bash
npm install -g @jevitate/cli
npx playwright install chromium          # the browser Jevitate drives

# Point it at a form in an app you're running locally, and try to break it:
jevitate explore --strategy adversarial --url http://localhost:3000/settings --fake-ai
```

It double-submits, feeds empty, boundary, long, unicode and invalid values, cancels and reloads
mid-edit, and acts while a save is still pending. It then prints a JSON result: `outcome`
(`clean`, `defects-found`, `inconclusive`, …), each defect with its evidence and fingerprint, and
the paths of its Recording, transcript and ready-to-file issue drafts (under
`.jevitate/logs/<date>/`, see [where jevitate keeps things](./docs/operations.md#where-jevitate-keeps-things)). The exit code is the outcome ([table below](#mission-outcomes-and-exit-codes)).

- Jevitate only visits the `--url`'s origin. Add `--allow <origin>` for each origin the app needs
  (include the app's own origin too, since `--allow` replaces the default).
- `--fake-ai` swaps the mission's advisory model calls for deterministic stand-ins. Nothing it
  reports depends on them.
- Logged-in app? Add `--storage-state auth.json` ([authentication](./docs/authentication.md)).

**Goal-directed runs** use a model to decide what to do next. Set up keys once
(`TYPESAFE_API_KEY` for Jev, `OPENROUTER_API_KEY` for text generation):

```bash
jevitate init        # prompts for missing keys; installs agent skills; registers the MCP server
jevitate explore --url http://localhost:3000/profile --goal "set the last name to Litmus and save" \
  --success 'requestMade:PUT /api/profile' --success 'reloadThen:valueEquals:[data-testid=last-name]|Litmus' \
  --real
```

The run succeeds only if the save request was sent and the value survived a reload, checked by
code. The model saying "done" doesn't count.

## See it work

The [demo](./docs/demo.md) runs against the repo's example app. It needs no keys and all of its
output is real:

```bash
jevitate explore --strategy adversarial --url http://127.0.0.1:5190/demo/profile \
  --invariants apps/example-site/demo-invariants.json --fake-ai --out demo-runs
# outcome: defects-found. "HTTP 500 from /demo/api/profile", and the invariant
# "saved-means-stored" (the page said Saved, but the server kept the old name)

jevitate verify-fix --result "$RESULT" --fingerprint "$FP_500"
# verdict: still-reproduces. "the defect's fingerprint fired on all 3/3 replay(s) that ran"

jevitate regression capture --from "$RECORDING" --result "$RESULT" --fingerprint "$FP_INV" \
  --id saved-means-stored --dir demo-regressions
jevitate regression run saved-means-stored --dir demo-regressions   # reproduces (exit 1)
# ...fix the bug, restart the app...
jevitate regression run saved-means-stored --dir demo-regressions   # fixed (exit 0)
```

## Why Jevitate?

Hand-written E2E tests check the paths someone thought of. The bugs that reach users tend to sit
somewhere else: a double submit, a name with an emoji, a reload halfway through an edit, a
request that hangs, a page that says "Saved" when the server said 500.

Autonomous agents can find those paths, but "the AI said it looks broken" is not a test result,
and an agent that clicked around once is not a regression suite. Jevitate keeps the exploration
and replaces the judgment with evidence:

- **Findings are evidence, not opinions.** A defect is concluded only by code: a hard signal
  from the browser, a check you wrote, or an invariant you declared.
- **Every finding is reproducible.** It comes with the exact steps, replayable in a fresh
  browser, and a stable fingerprint that dedupes it across runs.
- **Fixes are verified, not assumed.** `verify-fix` replays 3 times by default. An intermittent
  signal is reported as `intermittent`, never as `fixed`.
- **Runs are honest.** A run that could not do its work (the page never rendered, it redirected
  to a login page, it exercised too little of the form) is `inconclusive`, never `clean`.

## How it works

| | Decided by |
| --- | --- |
| **What to try next** | Goal and usability missions: **Jev** ([TypeSafe](https://typesafe.ai)'s judgment model) picks among the controls code found. Adversarial, coverage, exploratory and `--feature` missions: **code strategies**, with Jev's opinion recorded as advisory only. |
| **Whether it failed** | **Code only**: HTTP 5xx, uncaught exceptions, console errors, failed requests, hangs confirmed by replay, your `--success` checks, your [invariants](./docs/invariants.md), your [backend log](./docs/backend-logs.md) matchers. |
| **Whether it's fixed** | **Replay**: the finding's Recording, in fresh browser contexts, compared by fingerprint. |
| **What gets committed** | A **Recording** (typed, deterministic steps) plus its oracle, minimized where possible. |

More: [how it works](./docs/how-it-works.md), including the architecture and package map.

## Capabilities

| | |
| --- | --- |
| **Missions** | `explore` with a `--goal`, or `--strategy adversarial \| coverage \| exploratory \| usability`, or `--feature <name>` ([exploration](./docs/exploration.md)) |
| **Success checks** | URL, visibility, text, values, counts, network (`requestMade`, `responseStatus`), persistence (`reloadThen`), computed style and layout. Find-out goals are answered only with grounded claims ([success checks](./docs/success-checks.md)) |
| **App-declared invariants** | rules over DOM, network and read-only probes, checked around every action ([invariants](./docs/invariants.md)) |
| **Reproduce and verify** | `verify-fix`, `regression capture`, `regression run` ([verification](./docs/verification.md)) |
| **CI** | `jevitate check --suite` with a budget, JUnit and SARIF; `report` and `diff` for deduped findings and baselines ([CI](./docs/ci.md)) |
| **Real apps** | storage-state logins, bound secrets and TOTP, fixtures that reset state around every replay, repeat-and-vote, persona and multi-actor runs ([auth](./docs/authentication.md), [fixtures](./docs/fixtures.md), [multi-run](./docs/multi-run.md)) |
| **Evidence** | hangs (confirmed by replay), page timing, backend log correlation, redacted issue drafts ([exploration](./docs/exploration.md), [operations](./docs/operations.md)) |
| **Journeys** | author a replayable flow from a goal, replay, self-heal under policy, load-test, share ([Journeys](./docs/journeys.md)) |
| **Usability review** | ranked, cited findings grounded in what the run observed. Advisory, never a gate |

## Use it from your coding agent

Jevitate gives Claude Code, Codex, Cursor or any MCP client a bounded QA loop: run a mission,
read a typed result, re-check a finding after a fix.

```bash
jevitate init                      # installs skills for detected agents and registers the MCP server
jevitate mcp --print-config claude # or cursor | codex | json: print the snippet, write nothing
```

The MCP server exposes an allowlist of domain tools (`queue_exploration`, `get_mission_result`,
`verify_fix`, `run_journey`, …). Raw browser tools such as `browser_click` or `page_evaluate` are
forbidden. An agent can ask for a mission, but it never drives the page. See
[agents and MCP](./docs/agents.md).

## Safety

- **Only origins you authorize**, checked before the browser opens and during the run.
- **Bounded**: hard action and decision ceilings, plus a no-progress detector, on every autonomous loop.
- **No dangerous clicks by default**: sign-out, delete, revoke and paid controls are refused
  unless you pass `--allow-destructive`. Find-out goals are read-only unless you pass
  `--allow-writes`, and hang replays never re-send a paid write. Every write request a run
  fires is listed.
- **Secrets never reach a model**: a redaction guard that fails closed, and bound secrets typed
  by code.
- **Page text is data, never instructions**: model prompts carry a prompt-injection guard.

Details: [safety model](./docs/safety.md) · [SECURITY.md](./SECURITY.md).

## Mission outcomes and exit codes

A run never answers with a crash. Every run ends in a typed outcome, and its transcript and
Recording are flushed step by step.

| Outcome | Exit | Meaning |
|---|---|---|
| `clean` | 0 | finished its budget and found nothing (goal: the success checks held) |
| `defects-found` | 1 | at least one confirmed defect (goal: a success check did not hold) |
| `inconclusive` / `crashed` | 2 | the run itself could not do its work, so its silence proves nothing |
| `hang` | 3 | the app hung, and the hang reproduced on replay |
| `intermittent` | 4 | a hang was observed but did not reproduce on every replay |

Goal runs also report their own `outcome` (`succeeded`, `exhausted`, `blocked`, …). Every value is
in [docs/outcomes.md](./docs/outcomes.md).

## Authenticated missions

`--secret` only **redacts** a value. To start logged in, pass a Playwright storageState
(`--storage-state auth.json`). To drive a login form, bind a field to an environment variable
(`--secret-field 'label=Password=env:APP_PASSWORD'`, plus `--totp` for MFA): code types it, and the
model only sees `«secret:VAR»`. Details: [docs/authentication.md](./docs/authentication.md).

## Status

Jevitate is pre-1.0 and under active development. Known limitations worth knowing:

- Goal and usability runs need API keys (`--real`), and they cost money per model call. Runs
  report `usage` with the full cost of Jev and generation calls; a model with no known price
  makes the total `partial` until you configure one
  ([operations](./docs/operations.md#usage-accounting)).
- Stateful and conversational runs against one account must run sequentially
  ([why](./docs/authentication.md)).
- A hard-signal defect (e.g. an HTTP 500) is re-checked with `verify-fix`, not committed by
  `regression capture`. Declare the broken rule as an invariant to commit it
  ([verification](./docs/verification.md)).
- Usability findings are advisory, and their quality grader is not yet calibrated across apps.
- Chromium only.

## Documentation

- [Docs index](./docs/README.md): every reference page
- [Demo](./docs/demo.md) · [How it works](./docs/how-it-works.md) · [Safety](./docs/safety.md)
- [Changelog](./CHANGELOG.md) · [Releasing](./RELEASING.md)
- Website: [jevitate.com](https://jevitate.com)

## Contributing

Bug reports, feature ideas and pull requests are welcome. Start with
[CONTRIBUTING.md](./CONTRIBUTING.md). It covers the local setup, how to run a single test file,
and the few invariants every change must keep. Please report security issues privately
([SECURITY.md](./SECURITY.md)).

```bash
pnpm install && pnpm -r build
pnpm exec vitest run packages/explore/src/success-checks.test.ts   # one test file
pnpm lint
```

## License

[MIT](./LICENSE)
