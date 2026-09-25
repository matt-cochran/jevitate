# Reddit post concepts

Post one at a time, a few days apart, only where the rules allow project posts (check each
subreddit's rules and self-promotion ratio first). Lead with the technical result, not the
project. Put the repo link at the end, reply to every technical comment, and don't cross-post the
same text.

---

## 1. r/QualityAssurance (or r/softwaretesting)

**Title:** A form that says "Saved" when the server returned 500: catching it with a declared
invariant instead of an assertion per test

**Body:**

A pattern I keep seeing in real apps: the UI checks for 4xx validation errors, but a 5xx falls
through to the success path. The page says "Saved", nothing was stored, and no E2E test catches
it because nobody wrote the "emoji in the display name" case.

Instead of writing that test, I tried declaring the rule once and letting a tool try to break it:

```json
{ "observe": {
    "saidSaved":  { "dom": { "selector": "[data-testid=status][data-state=saved]", "read": "count" } },
    "typedName":  { "dom": { "selector": "input[name=displayName]", "read": "value" } },
    "storedName": { "probe": { "get": "/demo/api/profile", "json": "$.displayName" } } },
  "invariants": [{ "id": "saved-means-stored", "when": { "control": { "name": "Save" }, "op": ["click"] },
                   "require": "saidSaved >= 1 -> storedName == typedName" }] }
```

An adversarial run (double submits, empty, long, unicode and invalid values, reload mid-edit)
checks the rule after every Save click. It found the violation, typed `مرحبا 😀 тест` while the
server still had the old name, alongside the raw HTTP 500. Replaying the recorded steps in 3 fresh
browser sessions reproduced it 3/3, and the replay became a regression that fails until the fix.

What I found useful about invariants over per-test assertions: they hold across every path a
tool (or a person) takes, so exploration can be as random as it likes while the verdict stays
deterministic.

Curious how others handle "the UI lied" bugs. Contract tests? Synthetic monitoring?

(The tool is Jevitate, open source: https://github.com/matt-cochran/jevitate. The demo above is
reproducible without API keys: docs/demo.md.)

---

## 2. r/node or r/typescript

**Title:** Replaying a browser bug 3 times before calling it fixed: lessons from building a
verify-fix command

**Body:**

I build an open-source browser-testing CLI in TypeScript (Playwright underneath). The command
that changed my mind the most was `verify-fix`: replay the steps that produced a finding and say
whether it's gone.

The first version replayed once. It reported flaky bugs as "fixed" whenever the signal happened
not to fire. Now:

- It replays N times (default 3), each in a fresh browser context, and says `fixed` only if the
  signal is absent on **every** replay that reached the step.
- Some-but-not-all is its own verdict, `intermittent` (exit code 4), never folded into fixed.
- A replay that couldn't reach the step (the element is gone, or it's ambiguous) is
  `inconclusive`, because a replay that never ran isn't evidence.
- Elements are matched exactly: a stable anchor (test id, unique id or name), or an exact role and
  accessible name plus the recorded index. If the count of same-named elements changed, the step
  fails instead of clicking whatever sits at that index now.

Exit codes map to outcomes, so CI can treat `intermittent` differently from `still reproduces`.

What other "honest verdict" rules would you want from a tool like this?

Repo: https://github.com/matt-cochran/jevitate (see `docs/verification.md`)

---

## 3. r/LocalLLaMA or r/ClaudeAI (agent tooling angle)

**Title:** Giving a coding agent browser QA without giving it `browser_click`

**Body:**

If you let a coding agent drive a browser directly (click, fill, evaluate), you get flaky runs
and verdicts that amount to "the model thinks it worked." I went the other way with an MCP server
that exposes only domain tools:

- `queue_exploration`: ask for a bounded mission against a *promoted* target (a human promotes
  targets).
- `get_mission_result`: a typed outcome with an exit code (`clean`, `defects-found`,
  `inconclusive`, `hang`, `intermittent`) plus fingerprinted defects with evidence.
- `verify_fix`: after the agent changes code, replay the finding in fresh sessions.

Raw browser tools (`browser_click`, `page_evaluate`, `get_cookies`, …) are on a forbidden list,
and the served tool list is checked against the allowlist. The model inside the tool can choose
what to try next, but defects are decided by code: HTTP 5xx, uncaught exceptions, hangs, declared
invariants. Secrets are redacted before any model call.

The loop that works for me: agent edits code → `verify_fix` → still reproduces → agent keeps
going. No screenshots to squint at.

Repo: https://github.com/matt-cochran/jevitate (`docs/agents.md`). `jevitate init` installs skills
and registers the server for Claude Code, Codex and Cursor.
