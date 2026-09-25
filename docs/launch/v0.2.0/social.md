# Launch copy

Attach the demo GIF or MP4 (docs/demo.md) to every post. Link the repo, not the website, on
developer channels.

---

## LinkedIn

I've open-sourced Jevitate v0.2.0: autonomous browser testing that turns discovered bugs into
deterministic regression tests.

The idea behind it: AI is useful for deciding *what to try* in a web app, but I don't want it
deciding whether the app *works*. So Jevitate splits the two jobs.

→ Exploration can be nondeterministic. A judgment model drives goal runs, and code strategies
plan adversarial and coverage runs (double submits, unicode input, reloads mid-edit, acting while
a save is pending).
→ Verdicts are code. A defect needs evidence the browser produced: an HTTP 500, an uncaught
exception, a hang that reproduces on replay, a failed check, or a rule the app team declared.
→ Fixes are replayed. Every finding carries a Recording. `verify-fix` replays it 3 times in fresh
browsers, and a flaky signal is reported as intermittent, never as fixed.

In the demo, a form says "Saved" while the server returns HTTP 500. Jevitate finds it, reproduces
it 3/3, commits a regression, and verifies the fix, with no API keys needed.

It's MIT licensed, runs locally, and plugs into coding agents (Claude Code, Codex, Cursor) through
skills and an MCP server that deliberately exposes no raw browser tools.

https://github.com/matt-cochran/jevitate

---

## X / short post (under 280 characters each)

**Main:**

> Jevitate v0.2.0 is out: autonomous browser testing that turns the bugs it finds into
> deterministic regression tests.
>
> A model can pick what to try. Only browser evidence decides pass/fail.
>
> MIT · no API keys for the demo
> github.com/matt-cochran/jevitate

**Thread follow-ups:**

1. > The demo: a form says "Saved" while the server returns 500. An adversarial run finds it in
   > ~45s, verify-fix reproduces it 3/3 in fresh browsers, regression capture commits it, and
   > after the fix, regression run passes.
2. > Verdicts are code only: HTTP 5xx, uncaught exceptions, hangs confirmed by replay, your
   > success checks, and invariants you declare in JSON ("if the page says Saved, the server has
   > the value"). The model's "looks broken" is advisory.
3. > For coding agents: an MCP server with domain tools only (queue a mission, read a typed
   > result, verify a fix). browser_click and friends are on the forbidden list.

---

## Developer communities (Discord, Slack, forums)

> I just released Jevitate v0.2.0, an open-source CLI that explores a web app in a real browser
> (Playwright/Chromium), reports only evidence-backed defects (5xx, uncaught exceptions, hangs,
> failed checks, broken declared invariants), and turns each one into a replayable regression.
> Adversarial and coverage runs work without any API keys. If you have a staging app with forms,
> I'd love to hear what it finds, and what it gets wrong:
> https://github.com/matt-cochran/jevitate (a 2-minute demo is in docs/demo.md)

Keep it to channels where sharing your own tools is allowed. Offer to help people run it rather
than asking for stars.
