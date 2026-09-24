# Show HN draft

**Title** (79 characters, within HN's 80):

> Show HN: Jevitate – Autonomous browser testing that turns bugs into regressions

The suggested "…into deterministic regressions" is 93 characters, too long for HN. Alternative
(76): `Show HN: Jevitate – a model explores your web app, code decides if it failed`

**URL:** https://github.com/matt-cochran/jevitate

**Post it** after v0.2.0 is on npm, the demo GIF is in the README, and you have a couple of hours
free to answer comments. Weekday mornings, US Eastern time, work well. The first comment should be
yours (below).

---

## Text (first comment)

Hi HN, I'm Matt. Jevitate is an open-source (MIT) CLI that explores a web app in a real browser
(Chromium via Playwright), tries to break it, and turns what it finds into deterministic
regression checks.

The problem I kept hitting: model-driven browser agents are good at *finding* interesting paths
through an app (the double submit, the emoji in a name field, the reload halfway through an
edit), but bad at *judging* the result. "The agent says it looks broken" isn't a test result, and
an agent that happened to click around once isn't a regression suite.

So Jevitate splits the two jobs:

- **What to try next** can be nondeterministic. In goal runs, a judgment model (Jev, from
  TypeSafe) picks among the controls the code enumerated. Adversarial, coverage and feature runs
  plan their actions in code: form misuse, boundary and unicode values, acting while a save is
  pending, breadth-first or novelty-first state frontiers.
- **Whether it failed** is decided only by code, from evidence the browser produced: HTTP 5xx,
  uncaught exceptions, console errors, failed requests, hangs (confirmed by replaying them), your
  own success checks (`requestMade:PUT /api/profile`,
  `reloadThen:valueEquals:[data-testid=name]|Ada`), and invariants you declare in a JSON file
  ("when the page says Saved, the server has the value that was typed"). A model's "this looks
  broken" is recorded as advisory, and nothing reads it into a verdict.
- **Whether it's fixed** is decided by replay. Every finding has a stable fingerprint and a
  Recording of the steps. `verify-fix` replays it in fresh browser contexts (3 times by default),
  and a signal that fires on some replays but not all is `intermittent`, never `fixed`.
  `regression capture` commits a failure as a Recording plus its oracle, minimized with ddmin when
  the oracle is a replayable assertion.

The demo in the repo needs no API keys. A profile form returns HTTP 500 for names outside
Latin-1, and the page still says "Saved". An adversarial run finds both the 500 and the
violated invariant in about 45 s, `verify-fix` reproduces it 3/3, `regression capture` commits
it, and after the fix `regression run` passes: https://github.com/matt-cochran/jevitate/blob/main/docs/demo.md

Other things that turned out to matter in real use:

- **Honest outcomes.** A run that couldn't do its work (redirected to a login page, exercised too
  little of the form, the target never rendered) is `inconclusive`, never `clean`. Exit codes
  map to outcomes, so it works in CI (`jevitate check` writes JUnit and SARIF).
- **Safety.** Runs are restricted to origins you authorize. Sign-out, delete and paid controls are
  refused by default. Secrets are redacted before any model call, and a bound password is typed by
  code while the model sees a placeholder.
- **Agents.** There's an MCP server with an allowlist of domain tools (queue a mission, read a
  result, verify a fix). Raw `browser_click`-style tools are deliberately forbidden.

Limitations: goal and usability runs need API keys and cost money per model call; it's
Chromium-only; runs against one stateful account should be sequential; a hard-signal defect like
an HTTP 500 is re-checked with `verify-fix` rather than committed by `regression capture`
(you declare an invariant to commit it); and it's pre-1.0.

I'd especially like feedback on the oracle design. What would you want a tool like this to treat
as a defect by default?

---

## Answers to prepare

- **"How is this different from Playwright codegen / record-and-replay?"** Codegen records what
  you did. Jevitate goes looking for what you didn't do, then gives you a replay of it. Replays
  match elements exactly by stable anchors or exact role and name, and never fall back to a guess.
- **"Why not let the LLM judge?"** Because the verdict has to be reproducible and cheap to re-run
  in CI. An oracle that is code gives the same answer on every replay, and a flaky signal is
  labelled `intermittent`.
- **"What does Jev do exactly?"** It answers typed questions (choose one of these controls, yes or
  no with a probability) in goal and usability runs. It never sees secrets, and its answers never
  set an outcome.
- **"Cost?"** Keyless for adversarial, coverage and feature runs with `--fake-ai`. Goal runs
  report `usage` (judgments, tokens, provider-reported cost). Jev calls are priced only if you set
  a unit price.
- **"Is it safe to run on production?"** It's designed for apps you're authorized to test. It
  refuses destructive and paid clicks by default and lists every write request it fires, but
  staging is the right place.
