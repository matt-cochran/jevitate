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

**Not yet:** cryptographic signing of approvals (for example with the approver's SSH key on a
hardware key, or one with a passphrase) would bind each approval to a person's key. It is the
strongest option and is future work.
