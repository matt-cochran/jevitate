---
name: jevitate-test-campaign
description: Plan and run an end-to-end release test campaign of a whole web app with jevitate: preflight, a jobs-to-be-done catalog, discovery runs → draft Journeys, journey-anchored adversarial/exploratory missions, full-stack evidence, triage by exit code, verify-fix and regressions, budgets, CI suites and the release gate. Use to test a release or "the whole app" across many user jobs. For one run, use that tool's skill.
---

A campaign is many bounded runs, chosen on purpose and read honestly. An untargeted sweep from the
landing page stays shallow (a handful of states near the entry pages) and never reaches the core
jobs. Anchor everything on the jobs users actually do. Load `jevitate-explore`,
`jevitate-run-journey`, `jevitate-verify-fix` and `jevitate-ci-check` for the flags of each step.

## 0. Targets and environments

- Test a non-production environment the human has authorized: a local dev server, a preview or a
  staging build. Name each in `.jevitate/environments.json` so Journeys run with `--env <name>`.
- Iterate on a dev or debug build (hot reload makes frontend fixes cheap). Timing findings there
  are advisory. Run the final round on the compiled release build before the gate, and leave load
  testing (`jevitate-load-test`) to a release-like environment.
- Never point a sweep at a database other test work is using. Seed or reset it (`--fixtures`, or an
  operator `--before`/`--after` hook) so runs don't pollute each other.

## 1. Preflight (stop on any failure)

- `jevitate ai status --json`: the keys must be accepted live, not just present.
- One tiny `--real` goal run proves the model path end to end before you queue an hour of runs.
- One Playwright storageState per persona (kept under `~/.jevitate/`, never committed). Check each
  still logs in: a quick goal run per persona with `--storage-state <file>` and a `--success`
  check on a page only that persona sees. Use `--save-storage-state` on the same file when the app
  rotates refresh tokens.
- Target health: the start URL answers and the backend is up. A dead target makes every run
  `inconclusive`, which tells you nothing.

## 2. Build the job catalog first

List every user job from the app's routes, API surface and product docs: persona, job, and the
signal that proves it worked. Write one goal spec per job (template below): the outcome only,
never the click path; independent `--success` checks (page or network state); preconditions;
whether it mutates state; and a run order (jobs that create data run before jobs that use it).
A job you can't write a checkable `--success` for is too vague. Split it or narrow it.

## 3. Discovery: one goal run per job

For each job, as the right persona, with no scripted path:

```bash
jevitate explore-author-journey --url <start-url> --goal "<outcome only>" --success "<check>" --id <job-id> --name "<job>" --storage-state <persona-file> --real --json
```

- Reached: an UNPROMOTED draft Journey is written. Promotion is a human decision. List the drafts
  and ask the human to review and run `jevitate journey promote <id>`. Never promote yourself.
- Stuck, detour, `exhausted` or `inconclusive`: that is a finding about the job itself
  (discoverability, UX, a broken step), not only a crash. Log it in the register.
- A question rather than a task ("how many seats does the plan allow?") is a find-out run: a
  `--goal "find out …; report the answer"` with no `--success`, read-only by default.

## 4. Journey-anchored missions (where most defects are)

Defects cluster mid-flow: a verification step, a checkout, a half-finished build. Start missions
from a promoted Journey's key intermediate states, not the landing page. The Journey's prefix is
replayed in the mission's OWN browser context (page, form contents and session kept), then the
mission takes over on the live page:

```bash
jevitate journey anchors <journey-id> --json   # the named states worth exploring from, with suggested probes
jevitate explore --from-journey <journey-id> --at-step <anchor|n> --param <k=v> --env <env> --strategy adversarial --storage-state <persona-file> --max-actions 60 --evidence-video --real --json
```

- `--at-step` takes an anchor name (from `metadata.anchors`) or a 1-based step number. Only the
  prefix's own `--param`s are required. `--strategy` may be goal, coverage, exploratory,
  adversarial or usability (`--feature`, `--repeat`, `--persona` and `--actor` are refused).
- A prefix that no longer replays ends the run `inconclusive` with `failure.kind: "journey-stale"`
  (exit 2): the Journey drifted. Fix or re-author it; never fall back to a bare `--url`.
- Results and findings carry `branch: {journeyId, step, anchor}`: the exact point they came from.
- `--at-step all` (or `anchors`) sweeps every step: each in a fresh session restored by
  `--fixtures`, `--max-actions` split evenly per step, one deduped report naming each defect's steps.
- `verify-fix` and regressions replay such a finding THROUGH the Journey prefix (re-supply secret
  params with `--param`); a stale prefix is `inconclusive` (`journey-stale`), never `fixed`.
- `--strategy adversarial` attacks the anchor: replaying a one-time code, swapping a tenant id
  mid-flow, a double submit at checkout, an expired share link, skipping a step-up (the anchor's
  `probes` list what to try). `--strategy exploratory` follows newly revealed controls from there.
  `--strategy usability --goal "<job>" --app-class <class>` critiques the job (`jevitate-ux-review`).
- `--persona <name=storageState>` (repeatable, without `--from-journey`) runs the same mission per
  role and diffs them; a 403 for one and 200 for another is a candidate authorization finding.
- `--invariants <file>` turns app rules ("Saved means stored") into code-decided defects. Lint
  them first: `jevitate invariants validate <files...> --url <url>`.

Sweep many anchors with a campaign (template below): discovery replays each job's whole Journey (a
stale one skips its missions), then every anchored mission runs in order with the spec's
`fixtures` restore around each run, and ONE deduped report comes back (each defect lists the
Journey steps it branched from):

```bash
jevitate campaign run .jevitate/campaign/campaign.json --real --json
```

Flags such as `--allow-destructive`, `--paid`, `--invariants`, `--log-source`/`--log-defect` and
`--evidence-video` on `campaign run` are forwarded to every mission; `--hook-timeout-ms` bounds the
spec's hooks. An invalid spec is refused with every problem listed (exit 64). Shell `before`/`after` restore
hooks in the spec run only with `--allow-shell-hooks`, and only when the human asked for them.

## 5. A small untargeted pass, plus non-journey attacks

Keep one `--strategy coverage --scope app` run per persona to find orphan and dead-end screens.
Attacks that no Journey reaches (direct API authorization, forged or reordered webhooks,
cross-tenant requests, session fixation across hosts) are scripted by the operator; record what
was tried in the register, so the gate can show they were covered.

## 6. Full-stack evidence on every run

Tail the backend while the browser runs, so each finding carries its server-side cause:
`--log-source docker:<container>` (or `file:<path>`), `--log-defect error`, and
`--log-correlation-header <name>` when the app propagates a request id. Matching log lines are
redacted and attached to the step that caused them. Add `--log-triage` so each finding carries only
its related lines (`defects[].relatedLogs`): put those in the issue, not the whole log. Add `--evidence-video` (a captioned clip per
defect) or `--screenshots`, and link the files from the issue.

## 7. Triage by exit code, then collect before fixing

`0` clean · `1` defects found · `2` inconclusive (proved nothing: never a pass; fix the budget,
session or check and rerun) · `3` hang · `4` intermittent · `64` refused, nothing ran. Report the
outcome you got. Never round it up.

1. Collect: a campaign's own `campaign.md` is already one deduped list; across campaigns and
   ad-hoc runs, `jevitate report --target <origin> --since <campaign-start> --json` dedupes every run
   into one defect list. Keep one register (template below) tagged by layer and severity.
2. Fix: frontend fixes under the hot-reload dev server, rechecked at once; backend fixes batched
   into one rebuild.
3. Prove: `jevitate verify-fix --result <run>.result.json --fingerprint <fp> --replays 3 --json` for
   every finding. Only `fixed` counts. Then `jevitate ledger add <run>.result.json <fp> --json` and,
   when the human asks, `jevitate regression capture --from <run>.json --result <run>.result.json --fingerprint <fp> --id <id> --json`.
4. Re-sweep the jobs the fixes touched, and compare: `jevitate diff <runA> <runB> --json`.

## 8. Budgets and machine limits

- Every run has a cap: `--max-actions` (and `--max-decisions` for model-driven runs). Start at
  40–60 per mission; raise it only for a run that ended `exhausted` on a real job.
- Run missions one at a time. Check free memory before each; a browser killed by the OOM killer
  reads as `crashed`, not as an app defect.
- Mark paid controls with `--paid <pattern>` so retries and hang replays never repeat them. Never
  add `--allow-destructive` or `--allow-writes` unless the human asked.

## 9. CI: promoted Journeys + a check suite

Put every promoted Journey, the invariants, the key goals and a few anchored missions in a suite,
and gate with `jevitate check --suite <suite.json> --target-build <sha> --json` (MCP `run_check`;
see `jevitate-ci-check`). Tag the release candidate's clean run as a baseline:
`jevitate baseline tag <name> <runs...>`. In CI, exit 1 fails the build, and exit 2 or 64 is a
broken check, never green.

## 10. The gate

Release only when: every job in the catalog has a promoted Journey that passes; every finding is
`fixed` by verify-fix (with a ledger entry or regression); the final round ran on the release
build; and no `inconclusive` run was counted as a pass. Anything short of that, report it as open.

## Templates

Job spec (one per job, `.jevitate/campaign/jobs.json`) — the catalog you plan from:

```json
[{
  "id": "invite-teammate",
  "persona": "admin",
  "storageState": "~/.jevitate/sessions/admin.json",
  "goal": "invite a new teammate by email and see them listed as pending",
  "success": ["textIncludes:role=table|Pending", "responseStatus:POST /api/invites=2xx"],
  "preconditions": ["an org with a free seat"],
  "mutates": true,
  "order": 3
}]
```

Anchors live on the promoted Journey itself (`metadata.anchors`, listed by `jevitate journey anchors <id>`):

```json
"anchors": [{ "name": "invite-form", "step": 4, "description": "the filled invite form", "probes": ["double submit", "invite into another org id"] }]
```

Campaign spec (`.jevitate/campaign/campaign.json`, for `jevitate campaign run`):

```json
{
  "version": 1,
  "name": "release-candidate",
  "env": "staging",
  "fixtures": "restore.json",
  "maxRuns": 40,
  "maxActions": 60,
  "jobs": [
    { "id": "invite-teammate", "journey": "invite-teammate", "storageState": "~/.jevitate/sessions/admin.json",
      "params": { "email": "new@example.test" }, "anchors": ["invite-form"], "strategies": ["adversarial", "exploratory"] },
    { "id": "checkout", "journey": "checkout", "anchors": ["payment", 6], "strategies": ["adversarial"], "maxActions": 40 }
  ]
}
```

Issue register (one row per deduped finding, `.jevitate/campaign/register.md`):

```text
| fingerprint | job | layer (fe/be) | severity | outcome | evidence | status (open/fixed/verified) | regression |
```

## What you must never do

- Never promote a Journey, approve an inbox item or capture a regression on your own. Ask.
- Never count `inconclusive`, `intermittent` or a single clean replay as passing.
- Never widen `--allow` beyond what the human authorized, and never test production.
