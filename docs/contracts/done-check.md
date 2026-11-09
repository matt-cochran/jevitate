# Job done-check contract (#800)

Status: contract for 0.30.0. A job's done check is a statement about the application's state that is
false before the job is done and true after it, whichever path got there. Code reads it in a fresh
browser context before and after a run, and its readings decide `job.attainment`
([did the job get done?](../outcomes.md#did-the-job-get-done)). The schema is `DoneCheckSpecSchema` in
`packages/journey/src/done-check.ts`, mirrored in `packages/adjudicator/src/evidence.ts`.

## 1. Where it lives: `jobs[].done`, or a Journey's `metadata.done`

The check lives on the job in `.jevitate/jobs.json`, so every Journey that does the job reads the same one:

```json
{
  "id": "file-an-issue",
  "trigger": "a customer reports a bug",
  "motivation": "file it as an issue",
  "outcome": "the team can see and fix it",
  "done": { "version": 1, "at": "/issues", "check": "textIncludes:#issue-list|${title}", "distinguishedBy": ["title"] }
}
```

`done` is optional, and a job without it loads as before. It is part of the job's content hash, so adding
or editing it makes an approved job stale: approve it again (`jevitate job approve <id>`). A Journey uses
the check of the job it links (`metadata.job`, set with `jevitate journey link <id> --job <jobId>`).

A Journey that links no job may carry its own check in `metadata.done`, in the same shape and under the
same lint:

```json
{ "metadata": { "id": "file-issue", "done": { "version": 1, "at": "/issues", "check": "textIncludes:#issue-list|${title}", "distinguishedBy": ["title"] } } }
```

A Journey that links a job always reads the job's check, never its own (and `journey shorten --job <id>`
reads that job's). Lint refuses `metadata.done` beside `metadata.job` as `done-check-invalid`: it would
never be read. A Journey with neither reads `no-check`.

## 2. Fields

Every object is strict: an unknown key is refused.

| Field | Type | Meaning |
| --- | --- | --- |
| `version` | `1` | the contract version; only `1` exists |
| `at` | string, up to 2048 | a path on the target origin, starting with one `/`: no scheme, host, protocol-relative `//`, backslash, whitespace or control character. `${name}` placeholders are allowed |
| `check` | string, up to 1000 | the reading, in the `--success` syntax, limited to the kinds below. `${name}` placeholders are allowed |
| `session` | `"fresh"`, optional | the only value, and the default: every reading is taken in a new browser context |
| `distinguishedBy` | array of names, optional | the placeholders whose value makes the "before" reading false for a Journey that creates its own data, such as the title that must not exist yet. Each must appear in `at` or `check` |

### Check kinds

Only kinds that name state. A step, an anchor or a reload is about one path, not about the app.

| Kind | Shape |
| --- | --- |
| `textIncludes` | `textIncludes:<target>\|<text>` |
| `count` | `count:<target>\|min=<n>,max=<n>` (either bound may be left out) |
| `attr` | `attr:<target>\|<name>=<value>`, `attr:<target>\|<name>` (present) or `attr:<target>\|!<name>` (absent) |
| `valueEquals` | `valueEquals:<target>\|<value>` |
| `http` | `http:GET <path>[\|<assertion>…]`: a GET on the target origin only |

A `reloadThen` is refused, since every reading is already a fresh session. The `<target>` and
assertion syntax are those of [success checks](../success-checks.md).

### Placeholders

`${name}` takes the run's value of that name: a non-secret parameter of the linked Journey, or an
`extract` output. A name may use letters, digits, `_`, `.` and `-`. In `at` and in an `http` URL each
value is percent-encoded as one URL component. A name that reads as a secret or a credential, or that the
Journey declares secret, is refused. So is a name that reaches into one path (`${step.3}`,
`${anchor.x}`). The run's evidence keeps the placeholders, never the values.

## 3. Lint codes

`parseDoneCheck` returns the spec or every issue it found, never a partial spec. An issue names the
field and the placeholder, never a value.

| Code | When |
| --- | --- |
| `E_DONE_CHECK_SHAPE` | the object does not match the schema (a missing field, a wrong type, an unknown key) |
| `E_DONE_CHECK_KIND` | `check` is not one of `textIncludes`, `count`, `attr`, `valueEquals`, `http` |
| `E_DONE_CHECK_SYNTAX` | an unclosed or badly named placeholder, a check that does not have its kind's shape, or a `distinguishedBy` name that is not a placeholder in `at` or `check` |
| `E_DONE_CHECK_AT` | `at` is not a path on the target origin |
| `E_DONE_CHECK_SECRET_REF` | a placeholder or a `distinguishedBy` name reads as a secret or a credential |
| `E_DONE_CHECK_PATH_BOUND` | the spec names a step, an anchor or a `reloadThen` |
| `E_DONE_CHECK_REF_UNBOUND` | a placeholder names neither a non-secret parameter nor an `extract` output of a linked Journey |

`journey lint` (MCP `lint_journey`) reports three rules about the job a Journey links, and the same rules
about a Journey's own `metadata.done` (it is the only Journey that reads it):

| Rule | Level | When |
| --- | --- | --- |
| `missing-done-check` | warning | a promoted Journey links a job that has no `done` |
| `done-check-invalid` | error | the job's `done` (or the Journey's `metadata.done`) has one of the issues above, or a Journey that links a job also carries `metadata.done` |
| `done-check-cannot-be-false` | warning | a linked Journey writes and the check names no `distinguishedBy`: after one run the check is already true, so a later run reads `already-true` and proves nothing |

Catalog analysis and a job's review sheet report a `done` that does not parse as the gap
`job.done-check-unparseable` (a warning).
`journey link`, `journey find` and MCP `find_capabilities` show the linked job's check as stored. A
Journey's review sheet (`journey review`, MCP `review_journey`) shows its own `metadata.done` as stored
(`proof.doneCheck`, "Done check") and carries its lint findings.

## 4. How a run reads it

| Surface | Before | After |
| --- | --- | --- |
| `journey run`, MCP `run_journey`, a drained `journey queue` / `queue_journey` call | before step 1, before any fixture and before the run's browser opens | after the last step and the end state |
| `explore --goal --job <id>`, MCP `run_exploration {job}`, `queue_exploration {job}` | once, before the run | after each `done` the model proposes; a false reading rejects that `done` |

Each reading opens a new headless browser context seeded with the run's storageState, navigates only to
the run's origin, and polls a page check for up to 3 s (an `http` check waits up to 2 s for the network to
settle). A persona without a storageState file cannot be seeded, and its reading is unknown. The two
readings, with their duration and whether they were taken in a fresh session, go into the run's
[evidence](./evidence.md) as `doneCheck`.

The verdict (`judgeDoneCheck`, `packages/adjudicator/src/rules-v1.ts`):

| Before | After | `job` |
| --- | --- | --- |
| false | true | `achieved`, `done-check` |
| false | false | `not-achieved`, `done-check` |
| true | any | `unverified`, `already-true` |
| unknown | any | `unverified`, `reading-unknown` |
| false | unknown | `unverified`, `reading-unknown` |
| no check | | `unverified`, `no-check` |

A reading taken on the run's own page (`inRun`) is never the deciding one. On a target declared
`trust: "harness"` the readings are kept in the evidence, and the job reads `unverified`, `harness`
whatever they say. A check that does not parse is not read: the job reads `reading-unknown`.

## 5. What it does not do

- It does not replace a Journey's `endState` checks, which are claims about its own path.
- It cannot say the Journey is the best way to reach the state, only that the state holds.
- A state that is always true (an account name) reads `already-true`. The way out is a Journey that makes
  its own data, named in `distinguishedBy`.
- A Journey's own `metadata.done` is not read when the Journey links a job: the job's check decides.
- It is as good as the person who wrote it.
