# Technical post outlines

Three articles, each built around one design decision in the code, with a runnable example.
Publish them after the launch, about a week apart, on the site blog or dev.to, and cross-link
them from the README "Documentation" section.

---

## 1. Why I don't let AI decide whether its own browser test passed

**Thesis:** In autonomous testing, a model is a good *proposer* and a bad *judge*. If the same
model that chose the actions also declares success, you get tests that pass because the model
says so. Separating proposal from adjudication is what makes autonomous testing usable in CI.

**Outline:**

1. The failure mode: an agent types into a form, sees a toast, says "done". Nothing was saved.
2. What "done" means in Jevitate: the goal loop may *propose* `done`, but the run succeeds only if
   every `--success` check holds, evaluated by code (`urlIncludes`, `valueEquals`, `requestMade`,
   `responseStatus`, `reloadThen:…`).
3. Find-out goals: when there is no page state to assert, the model's answer is accepted only if
   every claim traces to text the run actually observed (grounding). An ungrounded report is
   rejected, and the run keeps looking.
4. The adversarial and coverage missions: the model's "looks broken?" is stored in the
   transcript and never read into the defect decision. Show the comment in the source.
5. Honest outcomes: why `inconclusive` exists, and why a run that exercised too little of a form
   is never `clean`.
6. What it costs you: goal runs still need a model to explore well. The verdict just doesn't
   depend on it.

**Code to discuss:**

- `packages/explore/src/success-checks.ts` (independent checks) and
  `packages/explore/src/answer.ts` (grounded answers).
- `packages/explore/src/missions/adversarial.ts`, the `softJudgment` comment: "Wiring this answer
  into the defect condition would be the single most dangerous regression this mission can
  suffer."
- `packages/explore/src/adversarial/defect-oracle.ts`: the hard-signal oracle, including why a 4xx
  during misuse is not a defect.
- `packages/domain/src/mission-outcome.ts`: outcome to exit code.

**Demo:** the goal run from the README (`--success 'requestMade:PUT /api/profile'
--success 'reloadThen:valueEquals:…'`) against an app whose save silently fails. Show the model
proposing `done`, the network check failing, and the run ending `exhausted` with the reason.

---

## 2. Nondeterministic discovery, deterministic regression

**Thesis:** Exploration should be allowed to be random, creative and model-driven. What comes
out of it must be deterministic: a fingerprinted finding, a Recording that replays exactly, and a
fix check that refuses to be fooled by flakiness.

**Outline:**

1. Two halves of the pipeline, and why they need different rules.
2. Fingerprints: signal + templated route (`/items/42` → `/items/:id`) + endpoint + message
   class, so the same bug is one finding across steps, runs and modes (`jevitate report`,
   `jevitate diff`).
3. Exact replay: stable anchors (test id, unique id or name), otherwise exact role and name plus
   the recorded index, and failure instead of guessing when the count changed.
4. `verify-fix`: N fresh-context replays, `fixed` only on unanimous absence, `intermittent` as a
   first-class verdict (exit 4). Hangs get the same treatment: confirmed only if they reproduce.
5. `regression capture`: which oracles can be replayed (success checks, network checks, declared
   invariants), minimization with ddmin, and why the engine's own safety refusals are never used
   as an oracle.
6. Fixtures: replaying from the same state (setup and restore around every replay).
7. CI: `jevitate check` with a budget, JUnit and SARIF, and baselines that classify findings as
   new, resolved, flaky or not-rerun (never "resolved" without evidence).

**Code to discuss:** `packages/explore/src/verify-fix.ts`, `packages/regression/src/minimize.ts`
(ddmin), `packages/regression/src/oracle.ts`, `packages/findings/` (identity and baseline diff),
`packages/cli/src/mission-fixtures.ts`.

**Demo:** `docs/demo.md` end to end: explore, then `verify-fix` (still reproduces 3/3), then
`regression capture`, `regression run` (reproduces), fix, `regression run` (fixed). Include the
invariant JSON and the invariant's before and after values from the result.

---

## 3. Giving an AI permission to break a web app, safely

**Thesis:** An autonomous tester has to be adversarial to be useful, and bounded to be allowed
near a real app. The guardrails belong in code paths the model can't reach, and each one needs a
test that proves it refuses.

**Outline:**

1. The threat model: a model that clicks "Delete account", pays for things, leaks a password into
   a prompt, follows instructions embedded in page text, or wanders off to another origin.
2. Origins: the allowlist is checked before the browser opens and during the run. MCP missions
   can only target human-promoted targets.
3. Clicks: the default safety policy refuses sign-out, destructive and paid controls
   (`--deny`, `--allow-destructive`). Every write request is recorded (`sideEffects`), and a
   repeat guard refuses re-firing the same write (RPC-aware, so gRPC-web reads aren't writes).
4. Secrets: redaction before any model call (fail closed), a field bound to an environment
   variable and typed by code (the model sees `«secret:VAR»`), TOTP computed locally, and
   storage-state contents never persisted in artifacts.
5. Prompt injection: page text as data, and the guard in every model prompt.
6. Bounds: action and decision ceilings, no-progress detection, stall timeouts, and a kill switch
   that still writes an honest partial result.
7. The agent boundary: an MCP allowlist with raw browser tools forbidden, and why "the served
   tools equal the allowlist" is itself a test.
8. Operator-only escape hatches (`--allow-shell-hooks`, `--allow-log-cmd`) that no model or MCP
   request can name.

**Code to discuss:** `packages/explore/src/safety.ts` and `mission-safety.ts`,
`packages/explore/src/side-effects.ts`, `packages/explore/src/authorized-targets.ts`,
`packages/explore/src/secret-fields.ts` and `redact.ts`, `packages/mcp-facade/src/tools.ts`
(`ALLOWED_TOOLS`, `FORBIDDEN_TOOLS`), and `scripts/check-no-permissive-fallback.mjs`.

**Demo:** run the adversarial mission against a page with a "Delete account" and a "Buy credits"
button next to the form. Show them in the refused list, the form still being attacked, and the
`sideEffects` list in the result. Then show `--secret-field` on a login form, and grep the
Recording and transcript for the password (absent).
