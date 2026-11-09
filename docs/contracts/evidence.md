# Run evidence contract: `RunEvidence` v1 (#812)

Status: contract for 0.30.0. `RunEvidence` is the one record a Journey run and a mutation proof write,
and the only input the adjudicator reads. A small, pure function (`adjudicate`, rules `v1`,
`packages/adjudicator`) decides the verdict from it; Jev's judgments are recorded in it as advisory and
never read for a verdict. The schemas are in `packages/adjudicator/src/evidence.ts`; this page names each
one and every field.

## 1. Where it is written

| Run | File |
| --- | --- |
| `journey run`, MCP `run_journey`, a drained `journey queue` / `queue_journey` call | `.jevitate/logs/<date>/journey-evidence-<stamp>-<suffix>/evidence.json`, beside the run's `journey-run-<stamp>-<suffix>.json` record |
| `journey verify --mutate` | `.jevitate/logs/<date>/journey-verify-<id>-<stamp>/evidence.json`, beside the proof's result |

The file is written atomically, mode `0600`, and only after it passes `RunEvidenceSchema`: an invalid
record is never on disk. A failure to write it never changes a run's outcome or a proof's verdict; the
run says why it was not written. `logs prune` removes an evidence folder with its run's record. The
`goal-run` subject kind is reserved: no goal run writes a record in 0.30.0. The 0.29.0
`journey-run-*.json` record is unchanged and deprecated.

## 2. Value-free by construction

There is no field for a parameter value, an extracted value, page text, a URL with a query or a request
body. Fields are enums, counts, shapes, hashes and keyed digests; every string is bounded and every
object is strict, so an extra key is refused. Parameters appear only as `paramsDigest`, an HMAC-SHA-256
under the key in `~/.jevitate/verify-checkpoint.key` over the sorted non-secret `name=value` pairs; a
secret parameter adds its name only. A write's path is its literal route text with every value masked.

### `Known<T>` (`KnownSchema`) and `UnknownReasonSchema`

A fact a gatherer may fail to establish is `Known<T>`, so "unknown" is a different value from zero:
`{ "known": true, "value": … }` or `{ "known": false, "reason": … }`. `UnknownReasonSchema` lists the
reasons:

| `reason` | Meaning |
| --- | --- |
| `page-not-watched` | the browser did not let the replay watch the page in time |
| `page-replaced` | the page or context changed while the fact was being read |
| `session-unavailable` | a fresh session could not be opened (auth, network) |
| `check-unevaluable` | the check names a target that does not exist on this page |
| `replay-stalled` | the replay never finished closing |
| `not-gathered` | this producer version does not gather this fact |
| `replay-errored` | the replay that would have established the fact errored |

## 3. `RunEvidenceSchema`: the record

| Field | Type | Meaning |
| --- | --- | --- |
| `schema` | `"jevitate.evidence"` | the record's name |
| `version` | `1` | the contract version |
| `producedAt` | ISO 8601 date-time | when it was produced, from `clock` |
| `producer` | object | `jevitate`: the producing build's version; `commit`: its commit, when known |
| `subject` | `EvidenceSubjectSchema` | what the run was about |
| `run` | `RunContextSchema` | how and where it ran |
| `steps` | array of `StepEvidenceSchema` | one entry per recorded step |
| `writes` | `WritesEvidenceSchema` | the whole run's writes, every replay included |
| `doneCheck` | `DoneCheckEvidenceSchema`, optional | the job's done-check readings, when the run read them |
| `mutation` | `MutationEvidenceSchema`, optional | present only on `journey verify --mutate` |
| `boundary` | `BoundaryEvidenceSchema`, optional | the boundary the run stopped at |
| `judgments` | array of `AdvisoryJudgmentSchema` | Jev's judgments, for people only |
| `notes` | array of strings, up to 500 each | code-templated reasons, for people |

## 4. The parts

### `EvidenceSubjectSchema`

| Field | Meaning |
| --- | --- |
| `kind` | `journey-run`, `goal-run` (reserved) or `mutation-proof` |
| `journey` | optional: `id` and `hash` (`journeyContentHash`) of the Journey |
| `job` | optional: `id` and `hash` (catalog content hash) of the linked job |
| `goalDigest` | optional: a keyed digest of a goal sentence, never its text |

### `RunContextSchema`

| Field | Meaning |
| --- | --- |
| `mode` | `test` or `automation` ([run modes](../run-modes.md)) |
| `channel` | `cli`, `mcp`, or `queue` for a drained `journey queue` call |
| `target` | `origin` (canonical `scheme://host[:port]` only), `environment` (its name in `environments.json`, optional) and `trust` |
| `paramsDigest` | the keyed HMAC of the non-secret parameters (above); `unkeyed` when the key could not be used |
| `secretParamNames` | the names of the secret parameters, never their values |
| `approval` | optional: the Journey approval's `channel` and `contentHash` |

`TargetTrustSchema` is `test`, `harness`, `production` or `unknown`. `EvidenceApprovalChannelSchema` is
`tty`, `non-interactive`, `mcp`, `ci` or `pr-review`, and mirrors `APPROVAL_CHANNELS` in
`@jevitate/journey`.

### `StepEvidenceSchema`

| Field | Meaning |
| --- | --- |
| `index` | 1-based, as in `step:<n>` site keys |
| `kind` | the recorded step kind |
| `outcome` | `ok`, `failed`, `skipped`, `not-reached` or `refused` |
| `postcondition` | `held`, `failed`, `none`, or unknown with a reason |
| `writes` | `Known` count of the writes this step sent |
| `refusal` | optional: the refusal's error code (`RefusalCodeSchema`: `E_[A-Z0-9_]+`, up to 64), never its message |

### `WritesEvidenceSchema` and `WriteShapeSchema`

| Field | Meaning |
| --- | --- |
| `sent`, `answered`, `aborted` | `Known` counts |
| `openAtClose` | `Known` count still open when the run or replay closed: `{known: true, value: 0}` is "none open", `{known: false}` is "could not tell" |
| `shapes` | up to 50 distinct `WriteShapeSchema` entries; the counts stay exact |

A write shape:

| Field | Meaning |
| --- | --- |
| `step` | the step that sent it |
| `method` | `WriteMethodSchema`: `GET`, `HEAD`, `OPTIONS`, `POST`, `PUT`, `PATCH`, `DELETE`, `CONNECT`, `TRACE`, or `OTHER` for anything else |
| `path` | literal route text only, parameters masked |
| `origin` | optional: only when off the Journey's own origin |
| `count` | how many writes had this shape |
| `status` | `Known`: `2xx`, `3xx`, `4xx`, `5xx`, `aborted` or `unanswered` |
| `refused` | optional `true`: the guard refused it |

### `DoneCheckEvidenceSchema`, `DoneReadingSchema` and `DoneCheckSpecSchema`

| Field | Meaning |
| --- | --- |
| `spec` | the check as stored (`DoneCheckSpecSchema`: `version`, `at`, `check`, `session`, `distinguishedBy`), with its placeholders, never resolved values. See the [done-check contract](./done-check.md) |
| `before` | the reading in a fresh session, before step 1 |
| `after` | the reading in a fresh session, after the last step and the end state |
| `inRun` | optional: a reading on the run's own page. Never the deciding one |

A reading (`DoneReadingSchema`):

| Field | Meaning |
| --- | --- |
| `value` | `Known` boolean: whether the check held |
| `session` | `fresh` or `run`. Only a `fresh` reading decides the job |
| `at` | `pre`, `post`, or the step index of an in-run reading |
| `durationMs` | how long the reading took |

### `BoundaryEvidenceSchema`

| Field | Meaning |
| --- | --- |
| `kind` | `wall`, `session`, `off-allowlist` or `new-tab` |
| `step` | the step the boundary was met at |
| `origin` | optional: the origin an off-allowlist or new-tab stop names |
| `signal` | `http-401`, `http-403`, `paid-control`, `login-url`, `write-refused` or `tab-opened` |

See [boundary outcomes](../outcomes.md#boundary-outcomes).

### `AdvisoryJudgmentSchema`

| Field | Meaning |
| --- | --- |
| `advisory` | always `true` |
| `task` | the judgment asked, e.g. `write.destructive`, `write.outside-intent` |
| `step` | optional: the step it was about |
| `probability` | 0 to 1 |
| `threshold` | optional: the threshold it was compared to (the write sentinel's is 0.5) |

No rule reads a judgment. The [write sentinel](../safety.md) in shadow mode records its answers here.

### `MutationEvidenceSchema` (`journey verify --mutate` only)

| Field | Meaning |
| --- | --- |
| `plan` | `mutations` (`id`, `kind`, `step`, `param`), `pairs` (`site`, `mutation`, `declared`) and `sites` (`site`, `check`, `required`) |
| `replays` | every replay the proof ran, as `ReplayEvidenceSchema` |
| `restore` | `ok`, `failed`, or `none` when the proof ran no fixture restore |
| `isolation` | `Known`: `isolated` or `state-crossed`, from the independence replay |
| `taint` | optional: the first finding that one replay may have decided another: `note` (`IsolationNoteSchema`), the mutation it names (`by`), and `carried` when an earlier interrupted run of this proof noted it |

`MutationKindSchema` is `skip`, `block-write`, `stale-value`, `swap-param`, `truncate-param` or
`guard-param`, and mirrors `MutationKind` in `@jevitate/journey`. A mutation id is `<kind>:<step>` or
`<kind>:<param>`: it carries a parameter's name, never its value. `IsolationNoteSchema` is `write-open`,
`independence-write-open`, `control-write-open`, `base-write-open`, `state-crossed`, `state-stuck`,
`independence-errored` or `siblings-undecided`.

A replay (`ReplayEvidenceSchema`):

| Field | Meaning |
| --- | --- |
| `ordinal` | its position in the proof |
| `role` | `base`, `independence`, `mutated`, `relaxed`, `targeted`, `control`, `at-base-time`, `rerun` or `closing` |
| `mutation` | the mutation id, for every role but base, independence and closing |
| `relaxedSites` | optional: the sites this replay relaxed |
| `site` | the target assertion site of a `targeted` replay and of its `control` |
| `outcome` | `passed`, `failed`, `not-applied` (the mutation had nothing to act on), `error` or `stalled` |
| `failedSites` | where it failed: a `step` (with `postcondition`), a `step-request` (with `checkIndex`), an `end-state` (with `index`), or `unevaluable`; each may carry `evaluated: true` |
| `writes` | its `WritesEvidenceSchema` |
| `waitsCut` | optional: sites whose waits were cut |
| `reused` | optional `true`: reused from a resume checkpoint |
| `retries` | optional: each retry's `reason` |
| `refused` | optional: why the gatherer refused a `targeted` proof; it reads as a cascade |

## 5. What the adjudicator reads from it

| Verdict | From |
| --- | --- |
| `job` | `doneCheck` and `run.target.trust` (`harness` forces `unverified`) |
| `checks` | `mutation`, with `countsForGate` from `run.target.trust`: `true` only for `test` and `harness` |
| `boundary` | `boundary`: always `inconclusive`; a proof whose run met one is `inconclusive` |

`judgments` and `notes` are never read. A record can be judged again later (`rejudge`), so a verdict can be
checked against the evidence it came from.
