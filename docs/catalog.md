# The catalog: personas, jobs and Journeys a person signed off

A Journey approval (`journey promote`, see [Journeys](./journeys.md#review-and-promotion-sign-off))
says "this flow works". It means more when the user the flow is for and the job it serves were
vetted too. The catalog holds the three, all human-approved and linked to each other:

| Entity | What | Lives in | Links |
|---|---|---|---|
| Persona | who the user is: a description, the account role, and (optionally) the session settings a run signs in with | `.jevitate/personas.json`, the [personas file](./multi-run.md) extended (there is no second file) | — |
| Job | a job story, with a priority | `.jevitate/jobs.json` | the personas it serves |
| Journey | how a persona does the job in this app | `.jevitate/journeys/` | `metadata.job` (a job id) and `metadata.persona` (a persona id) |

It is opt-in. A project without `personas.json` / `jobs.json` works exactly as before, and a Journey
that links nothing promotes exactly as before (its review sheet says "not linked to a job/persona").

## Job stories

A job is a [job story](https://learningloop.io/glossary/job-stories-jtbd):

> **When** [trigger], **I want to** [motivation], **so I can** [outcome].

The trigger is a situation, not a persona; the outcome is what the user can do once the job is
done, not a feature. A job is stored as its three parts and rendered with the template:

```json
[
  {
    "id": "invite-teammate",
    "trigger": "a new colleague joins my team",
    "motivation": "invite them by email",
    "outcome": "work on our projects together from their first day",
    "personas": ["admin"],
    "priority": "high"
  }
]
```

- `id`: 1-64 of `[A-Za-z0-9._-]`, starting alphanumeric.
- `trigger`, `motivation`, `outcome`: required, non-empty. **A job missing any of the three is
  refused** (`E_CATALOG_INPUT`, exit 64). Each command that reads the catalog refuses it, and none
  skips it.
- `personas`: the persona ids it serves. `priority`: `high` | `medium` | `low`.
- The [test-campaign](../packages/skills/skills/jevitate-test-campaign/SKILL.md) planning fields
  (`goal`, `success`, `preconditions`, `mutates`, `order`, `storageState`, and a single `persona`,
  which counts as one of `personas`) are still accepted.

The file is a bare array or `{"jobs": [...]}`. `.jevitate/campaign/jobs.json`, where the
test-campaign skill used to keep jobs, is still read when `.jevitate/jobs.json` does not exist.
If both exist, the catalog is refused until you merge them, so the two files can't quietly drift apart.

### The job's outcome fields

A job can also carry the shared jobs-to-be-done fields (the ones a
[Journeeze catalog bundle](#publishing-to-journeeze) carries). All of them are optional:

```json
{
  "id": "invite",
  "trigger": "a colleague joins my team",
  "motivation": "invite them by email",
  "outcome": "work together from their first day",
  "personas": ["admin"],
  "kind": "core",
  "context": ["team plan"],
  "steps": [
    { "id": "choose", "name": "Choose who to invite", "stage": "define" },
    { "id": "send", "name": "Send the invitation", "stage": "execute" }
  ],
  "desiredOutcomes": [
    { "id": "invite-fast", "step": "send", "direction": "minimize", "measure": "time",
      "object": "the time it takes to get a teammate invited", "gulf": "execution",
      "metric": { "kind": "duration", "from": "members-open", "to": "invite-sent", "stat": "p50" },
      "target": { "op": "<=", "value": 60, "unit": "s" } },
    { "id": "invite-right", "direction": "minimize", "measure": "likelihood",
      "object": "the likelihood of inviting the wrong person",
      "metric": { "kind": "error", "at": "invite-sent" }, "guardrail": true }
  ],
  "constraints": ["SSO-only workspaces cannot invite by email"],
  "provenance": "team_hypothesis",
  "revision": 3,
  "lastValidated": "2026-10-09",
  "extensions": { "journeeze": { "board": "growth" } }
}
```

| Field | What |
|---|---|
| `kind` | `core` (the job itself), `setup` (lifecycle support) or `related` (an adjacent job). |
| `parent` | the id of a declared job this one belongs to (no cycles). |
| `context`, `constraints` | up to 20 one-line strings each. |
| `steps` | up to 30 solution-free job steps `{ id, name, stage? }`. `stage` is one of the universal job map's `define`, `locate`, `prepare`, `confirm`, `execute`, `monitor`, `modify`, `resolve`, `conclude`. |
| `desiredOutcomes` | up to 50 outcomes `{ id, step?, direction, measure, object, clarifier?, gulf?, metric?, target?, guardrail?, priority? }`: `direction` is `minimize` or `maximize`, `measure` is `time`, `likelihood`, `effort` or `count`, `gulf` is `execution` or `evaluation`, and `step` (a job step id) leaves the outcome on the whole job when absent. `guardrail: true` marks a counter-outcome that must never get worse. |
| `metric` | where an outcome is measured, one of: `duration` (`from`, `to`, `stat` `p50`/`p75`/`share_under`; `threshold` in seconds with `share_under` and only with it), `completion` (`from`, `to`), `abandon`/`repeat`/`error`/`assisted` (`at`), `answer` (`question` `got_it_done`/`harder_than_expected`/`understood`, `value` `yes`/`no`, or `partly` for `got_it_done` only). `from`/`to`/`at` name an [anchor](#anchors-where-the-jobs-steps-start-and-end) or the reserved `job_start` / `job_end`. |
| `target` | what good enough is: `{ op: "<" \| "<=" \| ">" \| ">=", value, unit: "s" \| "percent" \| "count" }` (a percent is at most 100). |
| `provenance` | where the content came from, weakest first: `ai_draft`, `team_hypothesis`, `customer_evidenced`, `behaviour_validated`. |
| `revision`, `lastValidated` | a whole-number revision; the date (`YYYY-MM-DD`) the job was last validated. |
| `extensions` | up to 16 namespaces (lowercase slugs) of free-form data, e.g. `jevitate-draft` (see [drafting](#drafting-desired-outcomes)). |

**Every one of these fields is part of the job's content hash**, `extensions` included. Editing
any of them makes an approved job stale (needs re-review), like editing its story. The job review
sheet (`job review`, MCP `review_job`) shows them as written.

## Personas

`.jevitate/personas.json` is the [#427 personas file](./multi-run.md). Entries now also take
`description`, `role` and their `approval`. `name` is the persona's id (`id` is accepted too). A
persona with no session yet (no `storageState`, no `login`) is a catalog-only persona: runs skip it.

```json
{
  "personas": [
    { "name": "admin", "description": "runs the team's workspace and its billing", "role": "admin",
      "storageState": "~/.jevitate/sessions/admin.json" },
    { "name": "viewer", "description": "reads shared projects, never edits", "role": "viewer" }
  ]
}
```

## Linking a Journey

Set the Journey's `metadata.job` to a job id and `metadata.persona` to a persona id. A
`metadata.persona` that names a catalog persona links it. Otherwise it stays the free-text
description it always was, except on a Journey with a `job`, where it is always read as a persona
id (an unknown one is a dangling link).

A Journey linked to a job can also say which of the job's desired outcomes it serves:
`metadata.serves: ["invite-fast"]` (ids of the linked job's `desiredOutcomes`).

## Anchors: where the job's steps start and end

A Journey's named [anchors](./journeys.md) mark the states it reaches. On a job-linked Journey they
are also the boundaries of the job's steps, and the points the job's outcome metrics measure from
and to:

```json
"anchors": [
  { "name": "members-open", "step": 2, "stepId": "s-3k9q1a", "jobStep": "choose", "boundary": "start" },
  { "name": "invite-sent", "step": 5, "stepId": "s-8d2m4x", "jobStep": "send", "boundary": "end" }
]
```

- `job_start` and `job_end` are the anchors of **every** job (the start and end of the job itself):
  a metric can always use them, and no Journey declares them.
- `jobStep` names a step of the linked job, and `boundary` (`start` | `end`, needs `jobStep`) says
  which end of it the anchor marks.
- `stepId` is the [stable id](./journeys.md) of the step the anchor follows. It is authoritative;
  `step` (the 1-based number) is kept for the bundle contract. `journey promote` stamps it.

The 0.10 anchor rules, each with its fix:

| Rule | What it needs |
|---|---|
| `anchor-name` | a name of 1-64 lowercase `a-z`, `0-9`, `.`, `_`, `-` that starts with a letter or digit (the fix suggests the spelling) |
| `anchor-step-id` | a `stepId` that is a step of the Journey |
| `anchor-step-mismatch` | `step` and `stepId` naming the same step |
| `anchor-unstamped` | on a Journey whose steps have ids, the anchor carries its step's id |
| `job-anchors` | a Journey linked to a job names at least one anchor |

plus the catalog references below (`serves` and `jobStep`). **Warn vs enforce:** existing Journeys
still load and run, and `journey lint`, the review sheet and `catalog status` only warn. `journey
promote` enforces the rules on a new promotion (no prior approval) and on a re-promotion whose
content changed beyond step ids, refusing with `E_JOURNEY_ANCHOR_RULES` (exit 64) and every
problem with its fix. Re-approving an unchanged Journey, or one whose only change is minted step
ids (`journey migrate --step-ids`), warns and passes.

## Reference checks

The catalog checks the references inside a job and from a Journey to its job. Every problem has a
stable code, a path into the item and a fix:

| Code | Problem | Kind |
|---|---|---|
| `job.duplicate-step` | a job step id declared twice | structural |
| `job.duplicate-outcome` | a desired outcome id declared twice | structural |
| `job.unknown-outcome-step` | an outcome's `step` is not a step of the job | structural |
| `job.unknown-parent` | `parent` is not a declared job | structural |
| `job.parent-cycle` | `parent` leads back to the job | structural |
| `journey.unknown-serves` | `serves` names an outcome the linked job does not have | structural |
| `journey.serves-without-job` | `serves` on a Journey that links no job | structural |
| `journey.unknown-job-step` | an anchor's `jobStep` is not a step of the linked job | structural |
| `journey.job-step-without-job` | an anchor's `jobStep` on a Journey that links no job | structural |
| `job.unmeasurable-metric` | a metric's `from`/`to`/`at` is neither `job_start`/`job_end` nor an anchor some Journey linked to the job declares | gap |
| `job.target-unit-mismatch` | a target's unit does not fit its metric (a duration is `s`, a `share_under` duration is `percent`, an `error` is `count` or `percent`, the rest `percent`) | gap |

**Severity.** On data as loaded, every problem is a `warning`: nothing here blocks a load, a run,
`catalog status` (its `refIssues`) or a review sheet, and `catalog analyze` lists them as findings.
An approval enforces: the structural problems (the ones a catalog bundle refuses) become `error`s.
`job approve` refuses a job with one (`E_JOB_BROKEN_REF`, exit 64), and `journey promote` refuses
a Journey's (`E_JOURNEY_ANCHOR_RULES`). Gaps stay warnings: an outcome is unmeasurable until a
Journey declares its anchor, and that is not an error.

## Approval and staleness

Each persona and job is `draft` until a person approves it:

```bash
jevitate persona review admin                 # the sheet: who, the jobs it serves, the Journeys linked to it
jevitate persona approve admin                # shows the sheet, asks you to type `admin` (or the hash's first 8 characters), records the approval
jevitate job review invite-teammate           # the story, its personas, which have a promoted Journey, the gaps
jevitate job approve invite-teammate --reviewed-hash <hash>   # bind the approval to exactly the sheet you read
```

The approval records `{ contentHash, at, provenance }` on the item, in the same file, the way a
Journey approval does (`provenance` is how it was made — see
[What "human approval" guarantees](#what-human-approval-guarantees)). The content hash leaves the approval out, so approving changes nothing that was
approved. A persona's hash covers what the persona is (id, description, role). Its session
settings are not covered: re-minting a session is not a new persona. `--reviewed-hash` refuses a
changed item (`E_CATALOG_REVIEW_STALE`, exit 64).

**Approving is a human act: it is CLI only.** MCP gets the read-only `review_persona`,
`review_job` and `catalog_status`, and there is no MCP tool that approves a persona or a job. On
the CLI, an approval needs an interactive terminal and a typed confirmation; without one it is
refused (`E_APPROVAL_NEEDS_HUMAN`, exit 64).

**Staleness.** Editing an approved persona or job changes its content hash, so it becomes
`stale`, shown as **needs re-review**. So does every promoted Journey linked to it. The review
sheets (`persona|job|journey review`) and `catalog status` show it, and re-approving the item clears it.

## Promotion order

`journey promote` (and `demo approve`) needs the Journey's linked job and persona to be approved.
A link that is unknown, `draft` or `stale` is *unvetted*, and promotion is refused
(`E_JOURNEY_UNVETTED`, exit 1) unless a person waives it:

```bash
jevitate journey promote invite --accept-unvetted "pilot: the job is reviewed next sprint"
```

The waiver is recorded on the approval: `metadata.approval.waivers`
(`[{ kind: "unvetted", reason, items: ["job:invite-teammate (draft)"] }]`). An unlinked Journey
needs no waiver.

## Pre-approval findings and acknowledgment

Every approval path (`persona approve`, `job approve`, `journey promote`, `demo approve`) runs
one shared pre-approval analysis of the item against the rest of the catalog. Its findings are
shown in the item's review sheet before the approval. The built-in deterministic checks are:

| Finding | Needs acknowledgment |
|---|---|
| `job.unknown-persona`: a job serves a persona `personas.json` does not declare | yes |
| `journey.persona-not-served`: the Journey's persona is not one the linked job serves | yes |
| `journey.unknown-job` / `journey.unknown-persona` / `journey.unvetted`: unapproved or dangling links | no, `--accept-unvetted` governs them |
| `job.unvetted-persona`, `job.no-persona`, `job.gap`, `persona.no-job`, `*.changed`, `journey.needs-re-review`, `journey.unlinked` | no (informational) |

If any finding needs an acknowledgment, the approval is refused (`E_APPROVAL_FINDINGS`, exit 1)
unless the approver acknowledges it:

```bash
jevitate job approve invite-teammate --accept-findings "the billing persona lands next sprint"
```

The reason and the acknowledged findings (`<analyzer>/<code>`) are recorded with the approval:
`approval.acceptedFindings` on a persona or job, `metadata.approval.acceptedFindings` on a
Journey. `--accept-findings` is the approver's own judgment and is a CLI flag only. Code applies
the rule to the typed findings, and a model never decides an approval. Further analyzers (the
readiness review and the catalog-wide conflict/duplicate analysis) plug into the same pipeline.
An analyzer that fails to run produces a finding that needs an acknowledgment. It does not wave
the approval through.

## Readiness review

Every review sheet can show a **Readiness** section, and every approval shows it. It has two layers,
printed apart so that advice never reads as a gate.

```bash
jevitate job review invite-teammate --readiness           # deterministic checks + INCOSE GtWR rules
jevitate job review invite-teammate --readiness --real    # … plus the advisory Jev questions
jevitate journey review invite --readiness --real --json  # MCP: review_journey {readiness: true, real: true}
```

**1. Deterministic checks.** Each check is `pass` (shown as `info`), `warn` or `fail`, with a
fix-it line:

| Subject | Check (`readiness/<code>`) |
|---|---|
| Journey | `readiness.links`: it links an existing job and persona |
| Journey | `readiness.links-approved`: both are approved |
| Journey | `readiness.intent`: a goal, success criteria, and each step's objective and expected result |
| Journey | `readiness.lint`: `journey lint` passes |
| Journey | `readiness.verify`: the `journey verify --mutate` result is known, current (for this content hash) and `proven` |
| Job | `readiness.story`: the trigger, motivation and outcome are present; `readiness.personas`: its personas exist and are approved |
| Persona | `readiness.description`: it says who the user is; `readiness.jobs`: a job serves it |

The writing rules of the INCOSE *Guide to Writing Requirements* (GtWR) that can be checked
mechanically run on every job story and persona (`packages/journey/src/gtwr-rules.ts`). Each
finding is `readiness/gtwr:<rule>@<field>`, cites its rule id, and names the individual
characteristic it protects:

| Rule | GtWR characteristic |
|---|---|
| `gtwr:vague-term` (user-friendly, fast, easy, …), `gtwr:negative`, `gtwr:pronoun-reference`, `gtwr:too-long` | unambiguous |
| `gtwr:escape-clause` (if possible, where practical, …), `gtwr:absolute` (always, never, all, …) | verifiable |
| `gtwr:combinator` (and/or, as well as, …), `gtwr:multiple-outcomes` | singular |
| `gtwr:open-ended` (etc., including but not limited to, …) | complete |
| `gtwr:empty-field`, `gtwr:trigger-is-persona` (a trigger that names a persona, not a situation) | conforming |
| `gtwr:outcome-is-feature` (an outcome that names a control, not a result) | necessary |

The rule ids and characteristic names follow the GtWR edition current when they were written. Check
them against the current edition when the guide changes. Readiness never adds a second gate: the
existing gates still block (lint errors need `--accept-weak`, unapproved links need
`--accept-unvetted`, broken links need the catalog-links acknowledgment), and no readiness finding
needs an acknowledgment of its own.

**2. Jev review (advisory).** With `--real` and a judgment key (`TYPESAFE_API_KEY`, or
`OPENROUTER_API_KEY` for Jev through OpenRouter; `--jev-provider` picks one), the sheet asks Jev a
few narrow typed questions (Noul). Each answer is shown with its probability:

| Subject | Question (`readiness-jev/jev.<name>`) | GtWR characteristic |
|---|---|---|
| Journey | `accomplishes_outcome`: do the steps accomplish the job's outcome for this persona? | correct |
| Journey | `end_state_proves_outcome`: do the end-state checks prove the outcome, rather than only that a page loaded? | verifiable |
| Journey | `steps_related`: is every step needed for the job? | necessary |
| Journey | `plausible_for_persona`: are the actions plausible for this persona's role? | appropriate |
| Journey | `expected_matches_deltas`: does each written expected result match what the step was recorded doing? | correct |
| Job | `outcome_oriented`, `trigger_is_situation` | necessary, conforming |
| Job | `unambiguous`, `verifiable`, `singular`, `necessary` | the same names |
| Persona | `unambiguous`, `singular`, `necessary` | the same names |

An answer below probability 0.5 reads **"not ready because … (GtWR: <characteristic>)"**. A Jev
finding never needs an acknowledgment and never changes an exit code. Jev advises, and code decides
(the [invariant](./invariants.md)). Without `--real` the layer says
`Jev review skipped: pass --real …`. With `--real` but no judgment key it says
`skipped: no judgment key`, and the deterministic layer still runs. Asking for a model without
`--real` would break the CLI's convention, so a configured key alone never triggers a call.

**Approvals.** `persona approve`, `job approve`, `journey promote` and `demo approve` always run the
readiness checks. They ask Jev only when given `--real` (MCP: `real: true` on `promote_journey` /
`approve_demo`). Otherwise the sheet says the Jev review was skipped.

**Cache and cost.** Answers are cached by the content hash of what was asked, in
`.jevitate/cache/jev/<sha256>.json`. `jevitate init` gitignores `cache/`. The cache holds only
answers (kind, value, probability). The question text and the catalog text are never written, and
nothing secret is ever asked. Re-reviewing unchanged content asks nothing new. The sheet's `jev`
field reports what ran: `status`, `asked`, `cached`, and `usage` (judgments, tokens, cost). Usage
is printed on stderr like any run's.

## Catalog status

```bash
jevitate catalog status          # the matrix and the lists, as text
jevitate catalog status --json   # the schema-checked report (MCP: catalog_status)
```

- **Jobs × personas matrix:** one row per job, one column per persona. `✓` means a promoted
  Journey covers the pair, `draft` means only unpromoted ones do, `MISSING` means none, and `·`
  means the job doesn't serve that persona.
- **Approved jobs with no promoted Journey**, and every job × persona **gap**.
- **Journeys linked to nothing**, and **dangling links** (an id the catalog does not declare).
- **Stale approvals:** edited personas and jobs, changed Journeys, and Journeys linked to a stale
  item.

- **Approvals:** every recorded approval (promoted Journeys, approved personas and jobs) and how it
  was made, e.g. `persona admin: approved at a terminal by sam (typed confirmation)` or
  `journey invite: approved non-interactively (likely an agent: CLAUDECODE)` (`approvals` in the
  JSON).

The test-campaign skill's release gate reads it. The command exits 0: it is a report, and whoever
reads it decides what it gates. With `--require-approvals [--allow-channels <list>]` it gates
approvals itself, the way `jevitate check --require-approvals` does: exit 1 when a promoted
Journey has no approval, or any approval is stale or was made over a channel that is not allowed
(default: only `tty`).

## Catalog analysis

Individual reviews can't see problems *between* items: two jobs that contradict each other,
duplicates, Journeys whose writes undo each other, a persona with no jobs, a catalog that has drifted
from the app. The INCOSE *Guide to Writing Requirements* calls these the characteristics of a
requirement **set**: complete, consistent, feasible, comprehensible, able to be validated, correct.
The catalog analysis groups its findings by them.

```bash
jevitate catalog analyze                  # deterministic layer (pairs, gaps, advice)
jevitate catalog analyze --real --json    # + Jev classifications (MCP: analyze_catalog {real: true})
jevitate catalog analyze --markdown --max-pairs 100
```

**Candidate pairs** are chosen by code, so the cost stays bounded and never grows to O(n²) model
calls. Each pair records why it was paired:

- jobs that serve the same persona, or share trigger/outcome terms;
- Journeys whose expected writes (from the [review sheet](./journeys.md#review-and-promotion-sign-off))
  hit the same resource, flagged when the writes oppose each other (`POST` vs `DELETE`,
  `enable` vs `disable`), and Journeys that do the same job as the same persona;
- personas with the same account role, or largely the same jobs.

**Jev classification (advisory, with `--real`).** Each judged pair gets one typed Choice with a
probability: `compatible`, `duplicate` (the same job), `overlapping` (one contains the other),
`conflicting` (the outcomes can't both hold, or the flows leave contradictory states) or
`dependent` (one must come first). The one-line reason is written by code from the two items' own
text and the pairing evidence, never model prose. `duplicate`, `overlapping` and `conflicting`
violate *consistent*, and `dependent` asks for an order to be stated (*comprehensible*).

**Completeness** (*complete*): personas with no approved job, approved jobs with no promoted
Journey, and (Jev, as a suggestion only, never auto-created) a persona whose jobs may not cover
what that user obviously needs.

**Update advice:** items edited since their approval and dangling links (*correct*), and promoted
Journeys whose last recorded result, the `journey verify --mutate` record, is `insensitive`
(*able to be validated*) or `inconclusive` (*feasible*). Journey run results are not persisted, so
the mutation proof is the last result the analysis can read. The advice is written as
"consider updating X because Y" and is never applied.

The report never changes a catalog file, a Journey or an approval. It always exits 0.

### Before every approval

The main use is incremental. Before `persona approve`, `job approve`, `journey promote` and
`demo approve` (and in every review sheet, and MCP `review_*`), the same analysis runs for the item
being approved:

- only the candidate pairs that involve it are judged, at most **8 per approval**. The rest are
  listed as an overflow finding, never silently dropped, and `catalog analyze` judges them;
- completeness: whether it fills a gap or leaves its persona/job without coverage;
- advice about the item and its linked Journeys.

The findings appear in the sheet's **Catalog analysis** section, next to Readiness, before the
confirmation.

**Acknowledgment threshold.** Code decides on the typed result: a `conflicting` or `duplicate`
classification with probability **≥ 0.7** on a pair involving the item being approved
**requires an acknowledgment**. The approval is refused (`E_APPROVAL_FINDINGS`, exit 1) unless
the approver gives `--accept-findings "<reason>"`, which is recorded as
`approval.acceptedFindings` (e.g. `catalog-analysis/conflicting:job:share-team`). Below the
threshold, and every other relation, the finding is informational. A review sheet and
`catalog analyze` show the same classification but never refuse. Without `--real` or without a
key nothing is classified, so nothing gates on it: the pairs are listed unclassified and the
section says the Jev classification was skipped.

Answers are cached by the pairs' content (see [the cache](#readiness-review)), so re-approving an
unchanged item asks nothing new.

## Drafting desired outcomes

A job with a story but no outcomes can get a first draft from the generation model:

```bash
jevitate job draft-outcomes invite --real          # 1-3 outcomes (--count, default 3), live gateway
jevitate job draft-outcomes invite --fake-ai --json   # the deterministic fake generator (pipeline smoke)
```

It needs exactly one of `--real` / `--fake-ai` (`E_JOB_DRAFT_ARGS`, exit 64). It drafts outcomes
(direction, measure, object, and a clarifier, a gulf and a job step when the model gives a valid
one; never a metric or a target), skips any that repeat an existing outcome, checks the job's
references as an approval would, and writes them into the job in `jobs.json`. The draft is marked
twice:

- the job's `provenance` becomes `ai_draft` when it had none (a stronger one is never downgraded);
- `extensions["jevitate-draft"].outcomes` lists the ids of the drafted outcomes not yet reviewed by
  the team. Delete an id as you review its outcome.

**It never approves.** It leaves the job's approval as it was, so an approved job becomes `stale`
(needs re-review) like any edit (the result says so in `approvalStatus`). Approving stays
`job approve`, a person's act. MCP: `draft_job_outcomes` (`jobId`, `count`, `real` | `fakeAi`).

## Publishing to Journeeze

[Journeeze](https://app.journeeze.dev) can import the catalog as a catalog bundle (v1.0).

```bash
jevitate catalog export --format journeeze-bundle --out dist/catalog            # writes dist/catalog/bundle.json
jevitate catalog export --format journeeze-bundle --out dist/catalog \
  --check jevitate-check/check.json --check nightly/check.json --product-name "Ledgerly"
jevitate connect journeeze                       # a person, once: where the upload key is kept
jevitate publish journeeze --dry-run             # export, validate, resolve the connection; send nothing
jevitate publish journeeze --product-name "Ledgerly" --json  # override the connected product's name
jevitate publish journeeze --json                # upload and wait until it is imported or refused
```

**What the bundle holds.** Personas (never their session settings), jobs as written (every field,
so the hashes recompute), **promoted** Journeys only with their links (`job`, `persona`,
`anchors`, `serves`), every approval reduced to `{contentHash, at, channel}`, the `jevitate check`
results (with machine baselines from clean runs of the approved Journey) and the machine findings.
**No media in 0.10:** no demos, no files. `--check <file>` (repeatable) names the check records to
include; the default is `<project>/jevitate-check/check.json` (the `check --out` default) when it
exists. `--product-name` sets `product.name` (default: the project's `package.json` name, else its
folder name). The same catalog gives the same bytes, so a re-publish is deduplicated by the
bundle's sha256. Personal data or a credential in clear, or a job with a structural reference
problem, refuses the export (exit 64); a Journey or check the bundle cannot carry is left out with
a warning. `catalog export` writes only `bundle.json` under `--out` (it refuses a directory holding
anything else), never uploads and never approves. MCP: `export_catalog_bundle` (`format`, `out` —
a directory inside the project —, `check`, `productName`).

**The upload key.** `connect journeeze` is CLI only (there is no MCP tool; `connect_journeeze` is
forbidden). A person at a terminal names where the key is kept (`env:<VAR>`, `cmd:<command>`,
`op://…`, `bw:<item>` or `pass:<path>`), or types the key hidden to check it first; jevitate checks
it with Journeeze (`whoami`), asks the person to confirm the product, and **saves only the
reference**, bound to the Journeeze origin, in `~/.jevitate/journeeze.json` (owner-only). The key
itself is never saved, never a flag, never in a result. In CI set `JOURNEEZE_UPLOAD_KEY` (and
`JOURNEEZE_URL` for another pinned host) instead; it wins over the saved reference. The key is
sent only to `https://app.journeeze.dev`, `https://app.staging.journeeze.dev` or a loopback host,
only in the `Authorization` header, and never after a redirect to another origin.

`publish journeeze` exports the bundle, uploads it, and polls until Journeeze reports it
`imported` (exit 0) or `refused` (exit 1, with the server's errors). It never approves. MCP:
`publish_to_journeeze` (`dryRun`, `productName`), which never takes or returns the key. A refusal
carries its specific code.

The bundle's `product.name` is the **connected product's** name — resolved from the saved
connection, or from `whoami` when the key comes from `JOURNEEZE_UPLOAD_KEY` — not the project's
`package.json` name. `--product-name` overrides it. Every `--dry-run` verifies the key with
`whoami`; if its product differs from the name this publish would send (the saved one, or an
explicit `--product-name`), nothing is exported and the run is refused with
`E_JOURNEEZE_PRODUCT_MISMATCH` (pass the right `--product-name`, or rerun `connect journeeze`).

| Code | Exit | Meaning |
|---|---|---|
| `E_JOURNEEZE_NOT_CONNECTED` | 64 | no `JOURNEEZE_UPLOAD_KEY` and no saved connection: a person runs `connect journeeze` |
| `E_JOURNEEZE_KEY_FORMAT`, `E_JOURNEEZE_KEY_UNRESOLVABLE` | 64 | the key is not a `jzu_…` upload key; the saved reference resolves to nothing |
| `E_JOURNEEZE_KEY_REFUSED`, `E_JOURNEEZE_KEY_REVOKED`, `E_JOURNEEZE_FORBIDDEN` | 64 | Journeeze refused the key (401), revoked it (it appeared in a URL), or it lacks the upload scope |
| `E_JOURNEEZE_URL`, `E_JOURNEEZE_ORIGIN` | 64 | not a pinned Journeeze host; a saved reference used for another origin |
| `E_JOURNEEZE_REF`, `E_JOURNEEZE_CONFIG` | 64 | a bad key reference; an unreadable connections file |
| `E_CONNECT_NEEDS_TTY`, `E_CONNECT_NEEDS_HUMAN`, `E_CONNECT_DECLINED` | 64 | `connect journeeze` without a terminal, inside an MCP call, or the person declined the product (nothing saved) |
| `E_JOURNEEZE_BUNDLE` | 2 | the bundle cannot be sent (over 16 MiB, not a v1 bundle, it contains the key) |
| `E_JOURNEEZE_CONFLICT`, `E_JOURNEEZE_UNAVAILABLE`, `E_JOURNEEZE_HTTP`, `E_JOURNEEZE_REDIRECT` | 2 | Journeeze refused (409), was busy (retry: the same bundle reuses its idempotency key), answered otherwise, or redirected |

See [CI](./ci.md) for publishing from a pipeline.

## What "human approval" guarantees

Approvals (`journey promote`, `demo approve`, `persona approve`, `job approve`, and the
`--accept-weak`, `--accept-unvetted` and `--accept-findings` waivers given with them) are meant to
be a person's sign-off. A coding agent with a shell can run the same CLI, so jevitate has three
layers. Each one guarantees exactly what is written here, and no more.

**1. Provenance — detection.** Every approval record (a Journey's `metadata.approval`, a persona's
or job's `approval`, and each waiver on them) carries
`provenance: { channel, agentSignals, user?, reason? }`:

| `channel` | How the approval was made |
| --- | --- |
| `tty` | A person typed the confirmation at an interactive terminal. |
| `non-interactive` | `--non-interactive-approval "<reason>"` (the reason is recorded). |
| `ci` | The same escape hatch, with a CI marker set (`CI`, `GITHUB_ACTIONS`, `GITLAB_CI`, `BUILDKITE`, `CIRCLECI`, `JENKINS_URL`, `TF_BUILD`). |
| `mcp` | An MCP tool call (`promote_journey`, `approve_demo`): an agent's approval, never a person's. |
| `pr-review` | In CI, an approval jevitate itself verified through GitHub: the entry's last change came from a merged pull request into the default branch, approved by a person with write access who is not its author and wrote none of its commits. Recorded with the pull request and reviewer. |

`agentSignals` lists the names of the markers found in the environment, never their values:
`CLAUDECODE` and `CLAUDE_CODE_*` (Claude Code), `CODEX_*` (Codex CLI), `CURSOR_*` (Cursor),
`AIDER_*` (aider), `GEMINI_CLI` (Gemini CLI), the CI markers above, plus `stdin-not-tty` /
`stdout-not-tty`. `user` is the OS user name, never an email. The review sheets,
`catalog status` and `journey list` show it in words.

This is detection, not proof. A marker is a hint: a person's terminal inside an editor may set
one, and a determined process can clear its environment, fake a TTY or edit the JSON. Provenance
catches the honest and the careless. It does not stop the determined.

**2. The typed confirmation — friction.** Each CLI approval shows its review sheet (with the
pre-approval findings, readiness and catalog analysis), applies the acknowledgment gate
(`--accept-findings` and the other waivers), and only then asks for the item id or the first 8 characters of the content hash the sheet shows. Each waiver is
confirmed the same way. This needs a real TTY on stdin and stdout. Without one the approval is
refused with `E_APPROVAL_NEEDS_HUMAN` (exit 64), and the message says how a person approves. A
mismatched answer is `E_APPROVAL_NOT_CONFIRMED` (exit 64). In both cases nothing is written.
A scripted setup (seeding fixtures, a demo repo) may pass
`--non-interactive-approval "<reason>"`. It is allowed, and it is recorded as `non-interactive`
(or `ci`), so it is never mistaken for a person's approval. A coding agent never uses it on its
own: it hands the approval to a person. The prompt is friction. A process that drives a
pseudo-terminal can type the answer.

**3. Git review — enforcement.** The approval records are files in the repository
(`.jevitate/journeys/`, `.jevitate/personas.json`, `.jevitate/jobs.json`), so the real control is
review of the change that adds them:

```bash
jevitate init --codeowners "@acme/qa"   # a marked CODEOWNERS block for those paths (idempotent)
jevitate check --suite ci.json --require-approvals          # in CI: fails on a non-tty approval
```

`init --codeowners` writes or merges a `# BEGIN JEVITATE CODEOWNERS v1` … `# END …` block into the
repository's CODEOWNERS (an existing one in `.github/`, the root, `docs/` or `.gitlab/`; else
`.github/CODEOWNERS`). Re-running it replaces the block in place, and malformed markers are
refused. CODEOWNERS does nothing alone: enable branch protection with "Require a pull request"
and "Require review from Code Owners" (GitLab: code owner approval on protected branches). Rules
later in the file override the block. `check --require-approvals` (and
`catalog status --require-approvals`) then fails any approval that is missing, stale or made over
a channel not in `--allow-channels` (default `tty`). With all three, an approval change merges
only after a code owner reviews it, and CI flags any approval that a person did not type.

**Approvals through pull-request review (`pr-review`).** With the CODEOWNERS review in place, the
approval can be the review itself: a person reviews and approves the pull request that changes the
Journey or catalog entry, and CI runs the approval (`journey promote`, `persona|job approve`) on a
push to the default branch. With no terminal, in GitHub Actions, jevitate verifies through the
GitHub API (with the job's `GITHUB_TOKEN`, never an argument) that the entry's content on the
default branch was last changed by a merged pull request approved by someone other than its author
(with `JEVITATE_PR_REVIEW_REQUIRE_CODEOWNER=1`, a CODEOWNER of the file), and records the approval
as `pr-review`. It is never a channel a caller can claim: no flag or MCP argument sets it, it is
never granted inside an MCP call, on a `pull_request` event, or for an approval with waivers or a
self-heal proposal (no reviewer saw those), and `demo approve <aspect>` never gets it. When the
verification fails, why is printed and the approval falls back to the usual paths
(`E_APPROVAL_NEEDS_HUMAN`, or `ci` with `--non-interactive-approval`). `check` and `catalog
status` with `--require-approvals --allow-channels tty,pr-review` re-verify every recorded
`pr-review` approval through GitHub, so a hand-written `pr-review` record is a violation
(`unverified`), never a pass. The [CI recipe](./ci.md) shows the workflow.

**Not yet:** cryptographic signing of approvals (for example with the approver's SSH key on a
hardware key, or one with a passphrase) would bind each approval to a person's key. It is the
strongest option and is future work.
