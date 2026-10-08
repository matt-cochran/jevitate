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

**2. The typed confirmation — friction.** Each CLI approval shows its review sheet, then asks for
the item id or the first 8 characters of the content hash the sheet shows. Each waiver is
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
