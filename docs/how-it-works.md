# How Jevitate works

Jevitate splits browser testing into two halves that are allowed to behave very differently:

- **Discovery** decides what to try. It may be nondeterministic: a judgment model choosing the
  next step toward a goal, or a code strategy walking a state space.
- **Verdicts and regressions** are deterministic. Code decides whether something failed, from
  evidence the browser produced, and a finding is re-checked by replaying a Recording.

A model can suggest where to look. It never decides whether the software passed.

## The pipeline

```text
 mission (explore)          oracles (code)                 artifacts                 follow-up
 ─────────────────          ──────────────                 ─────────                 ─────────
 goal / usability  ─┐       HTTP 5xx, page errors,
 adversarial        │       console errors, failed         Recording (typed steps)   verify-fix: replay N times
 coverage           ├─────► requests, hangs,        ─────► transcript + evidence ──► regression capture / run
 exploratory        │       your --success checks,         result.json (outcome,     jevitate check (CI gate)
 --feature         ─┘       your invariants,               fingerprinted defects)    report / diff / baseline
   (real Chromium           your log matchers              issue drafts
    via Playwright)
```

1. A **mission** opens Chromium through Playwright, restricted to the origins you authorize, and
   acts on the controls it finds. Every action goes through one gated `act()` path (scope,
   safety policy, repeat guard).
2. After every action, the **oracles** read what happened: responses, console, uncaught
   exceptions, request failures, DOM state, hangs, your declared checks. A defect is concluded
   only from these.
3. Each defect gets a stable **fingerprint** (signal, templated route, endpoint, message class)
   so repeats are deduplicated across steps, runs and modes. Each carries its **reproduction**:
   the Recording and the step to replay up to.
4. **verify-fix** replays that Recording in fresh browser contexts (3 times by default) and
   reports `fixed` only if the signal is absent on every replay that reached the step.
   **regression capture** commits a failure as a Recording plus oracle, minimized where it can
   be. **jevitate check** runs Journeys, goals, missions and re-checks as a CI gate.

## Who decides what

| Question | Decided by |
| --- | --- |
| What to try next, goal and usability missions | **Jev**, TypeSafe's judgment model, choosing among controls code enumerated. A generation model (via OpenRouter) writes form text. |
| What to try next, adversarial, coverage, exploratory and `--feature` missions | **Code strategies**: form misuse (double submit, boundary values, cancel then save, reload with unsaved edits, acting while a save is pending), breadth-first or novelty-first state frontiers. Jev's "does this look broken?" is recorded as advisory only. |
| Did it fail? | **Code only**: hard signals, hangs confirmed by replay, your `--success` checks, your invariants, your `--log-defect` matchers. |
| Did the goal succeed? | Your `--success` checks, evaluated by code. For a find-out goal, the model's answer is accepted only when every claim is grounded in text the run actually saw. |
| Is it fixed? | Replays in fresh contexts, compared by fingerprint. One clean replay is never enough. |
| Is this a usability problem? | Advisory findings, ranked and cited. They never gate an outcome or CI unless you opt in. |

Because the adversarial, coverage, exploratory and feature missions plan their actions in code,
they run without model keys: `--fake-ai` swaps the advisory model calls for deterministic
stand-ins, and `--feature` needs no gateway flag at all. Goal and usability runs need `--real`.

## Outcomes are typed and honest

Every run ends in a typed outcome with an exit code: `clean` 0, `defects-found` 1,
`inconclusive`/`crashed` 2, `hang` 3, `intermittent` 4. A run that could not do its work is never
reported as clean. For example, an adversarial run that exercised too little of its target is
`inconclusive`, and so is a run whose start URL redirected to a login page. See
[outcomes.md](./outcomes.md).

## Where things live

| Package | Role |
| --- | --- |
| `packages/cli` | the `jevitate` command, MCP server and local UI; bundles every other package |
| `packages/explore` | missions, oracles, hang detection, success checks, invariants, safety policy |
| `packages/playwright` | the browser pool, contexts and resource-pressure admission control |
| `packages/recording`, `interpreter`, `screenplay` | the Recording schema and deterministic replay |
| `packages/regression` | reproduce, minimize (ddmin) and commit regressions |
| `packages/findings` | finding identity, consolidated reports and baseline diffs |
| `packages/ux` | usability review: rubric, grounding, confidence and quality grading |
| `packages/mcp-facade` | the MCP tool allowlist; raw browser tools are forbidden |
| `packages/ai-core`, `secrets` | model gateways, redaction, credentials, usage accounting |
| `packages/journey`, `load`, `sources`, `recorder` | Journeys, load testing, distributed sources, recording by demonstration |
| `apps/example-site` | the fixture app the tests and the [demo](./demo.md) run against |
