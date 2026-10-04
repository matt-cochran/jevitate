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
   acts on the controls it finds — including controls inside a web component's open shadow root
   (a closed shadow root is opaque, so its controls are never offered). Every action goes through
   one gated `act()` path (scope, safety policy, repeat guard).
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

## Action deltas: what each action changed

**Opt-in**: `--action-deltas` on `explore` (every strategy but `--feature`), `journey run`,
`journey annotate`, `journey demo` and `verify-fix`; the MCP tools that mirror them take
`actionDeltas`, and check-suite items take the `actionDeltas` option. Off by default: nothing is
captured, nothing is added to any prompt or result, and every mission behaves exactly as before.
On, after every action code records **what changed on the page** (#303) as one structured,
redacted record that code, Jev and the model all read. (`demo create`/`demo approve` do not take
it: they render a Journey's demo, whose steps' Recording deltas `journey demo` can caption.)

- **Capture.** An accessibility snapshot (Playwright `ariaSnapshot`) right before the action and
  at the next settled perception, plus one of the target's own form, dialog or region; the
  announcements the page monitor's observer noted in between (a toast or banner gone before the
  page settled); the requests the action set off (method, path, status; the page's background
  polling excluded); and the URL and title. Everything is redacted first (see
  [safety.md](./safety.md)).
- **Noise control, code first.** The settled page is snapshotted twice with no action in between
  (at perception and right before the action, and once per route, after its first action, at
  least one second apart): nodes that change on their own (a clock, a carousel, a counter, a random
  id) are volatile for that route and dropped. The rest is ranked by closeness to the action: the
  target itself, its form / dialog / region, live regions (`status`, `alert`, `log`), dialogs that
  opened or closed. A big change (a list of 50 rows replaced) is collapsed into one line per
  container, and the record is capped (12 changes, 160 characters each).
- **Relevance, Jev advisory.** Changes code could not tie to the action are labelled by Jev:
  relevant, irrelevant, or "changes on its own". An ignore rule is accepted only for a node code saw
  change with no action, and is cached per route, so Jev is not asked on every action.
- **Verdict, code only.** `no-change`: nothing changed after the volatility filter and no request
  was sent. `relevant-change`: at least one change tied to the action (locality, a navigation, an
  announcement, or a Jev `relevant` label). `inconclusive`: changes none of which is tied, a request
  with nothing visible changing, or a partial capture (a canvas, a closed shadow root, a frame, a
  snapshot timeout).
- **Use (when on).** `no-change` is the only verdict that counts an action toward the no-progress stop;
  `relevant-change` is progress; `inconclusive` counts as neither. Before acting, code states the
  change it expects (the page navigates, the field shows the typed value, the message appears, the
  checkbox flips) and compares it with the delta after; a mismatch is told to the model. Each
  delta is attached to its transcript step (`delta`, also in the `--json` result's `transcript`) and
  Recording step (`delta`, a measurement that is never replayed); the result gains `actionDeltas`
  (verdict counts, per-action overhead), the human output a `DELTAS` count and a `DELTA` line per
  recent step, and one bounded line (`effect of click "Save": relevant-change — …`, at most 400
  characters) goes into the model's step history.
- **Overhead (when on).** Two accessibility snapshots, one scoped snapshot and a diff per action:
  measured at about 50–110 ms per action on a small page and 0.35–0.5 s on a 400-row page with 800
  controls (real Chromium). Each snapshot is bounded at 1.5 s, past which the capture is partial.
  Once per route, after its first action, the volatility baseline waits up to 1 s (never before an
  action). Jev's relevance labels (cached per route, at most 8 calls a run) only for changes code
  could not tie.

Where deltas are used, when on:

- **Goal and usability runs** — the no-progress check, expected-vs-actual, the model's step
  history and the transcript / Recording / result (above). **Persistence:** a step whose delta is
  `relevant-change` and whose write went through (2xx, or a form POST answered by a redirect) is
  re-checked once, at a safe point (no typed text unsent, no write in flight, not a read-only run):
  the page is reloaded with a GET of the same URL — never a re-post — and code checks whether the
  step's lasting changes (not its toasts or the target's own state) still show: `persisted: yes`,
  `no` (after a 2xx write: saved but not stored — listed under the result's
  `actionDeltas.notPersisted` as evidence, never a defect on its own, so it never duplicates a
  declared `reloadThen` check or a request-payload invariant, #295), or `inconclusive`. The reload
  is recorded as a navigation step. **Grounding:** a report may quote what an action announced or
  lastingly showed (a toast gone before the report), since that text is observed page text
  (redacted); a form field's own value never grounds anything (#239), and every other grounding rule
  stands.
- **Replays** (`journey run|annotate|demo`, `verify-fix`) — each replayed step's delta is recorded
  and compared, by code, with the delta its Recording stored (verdict, the stored changes, the
  navigation). `journey run` returns `actionDeltas` (each step's delta, `matchesRecorded`,
  `differences`, a mismatch count); `verify-fix` attaches the defect step's comparison to each
  attempt and names a mismatch in its reason — evidence, never the verdict; `journey annotate`
  drafts a step's expected result from its delta, by code (the model is asked only for what the
  delta cannot say); `journey demo` adds an "observed" line (the step's recorded delta) to its
  subtitles and guide.
- **Adversarial and coverage runs** — each settled action's delta is on its transcript step;
  a defect carries the delta of the action it was first seen at (`actionDelta`); the result's
  `actionDeltas` counts verdicts, and coverage lists the actions that changed nothing (`noEffect`,
  dead controls). Neither mission changes what it plans: a misuse with no visible effect is often
  the app behaving correctly, and the coverage frontier still expands by state.

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
`inconclusive`/`crashed` 2, `hang` 3, `intermittent` 4, and a usage error 64
([every command's codes](./outcomes.md#exit-codes)). A run that could not do its work is never
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
| `packages/domain`, `application` | pure domain rules (pacing, throttles, quiet hours, mission outcome, crash attribution, issue filing) and the ports the rest implement |
| `packages/missions`, `inbox` | mission targets and the mission queue; the human-in-the-loop inbox store |
| `packages/runtime`, `daemon`, `storage-sqlite` | Journey runner and self-heal, per-profile daemon, SQLite storage for site policies, budgets and activity |
| `packages/skills` | skill manifests and frontmatter for coding-agent installs |
| `packages/jevitate-cli-alias` | the bare `jevitate` alias of `@jevitate/cli` (the only other published package) |
| `apps/example-site` | the fixture app the tests and the [demo](./demo.md) run against |
