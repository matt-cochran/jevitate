# Linked Journeys: readiness, typed handoffs, handback and the review bundle

0.18.0 adds five tools for a workflow of two Journeys, where one finds records and the other prepares
something for a person. They build on the existing checks and add no new approval or authority. The
worked example is the Bizops fixture ([bizops-workflow.md](bizops-workflow.md)), and the precise
shapes are in [docs/contracts/](contracts/).

## Where things are (#585)

Every command that reads Journeys or the catalog takes the same two flags:

| Flag | What it sets |
| --- | --- |
| `--project <path>` | the project: a `.jevitate/` directory or the directory that contains it. This sets the catalog and the default Journey store |
| `--journeys-dir <path>` | the Journey store only (it wins over `--project` for Journeys) |

```bash
jevitate journey list --project ../app            # from anywhere
jevitate catalog status --project ../app/.jevitate
jevitate where --project ../app                   # what resolves where, and why
```

The old `--dir` still works with its old meaning on each command (the Journey store for `journey …`
commands; the project for `persona`, `job`, `catalog` and `journey link`). It prints one deprecation
line on stderr, never in `--json` output. Combining `--dir` with the new flags is refused.

Every refusal exits 64 with a next action:
- an explicit path that does not exist is refused (`E_PROJECT_DIR_MISSING`). Nothing is created.
- a `--project` that is not a project is refused (`E_PROJECT_LAYOUT`).
- a catalog command outside any project is refused (`E_PROJECT_NOT_FOUND`). There is no fallback to
  `~/.jevitate` for the catalog.

The same Journey has the same content hash whichever flag or directory reached it. MCP tools never
take these flags: the store belongs to the server.

## Typed handoffs between Journeys (#582)

The producing Journey declares the record it returns:

```json
"outputs": {
  "contract": "community-conversation@1",
  "collection": "records",
  "key": ["commentId", "account"],
  "fields": { "commentId": { "type": "id" }, "sourceText": { "type": "text" }, "permalink": { "type": "path" } }
}
```

The consuming Journey declares what it accepts, the request a caller supplies, and how both bind to
its params:

```json
"inputs": {
  "accepts": "community-conversation@1",
  "request": { "fields": { "commentId": { "type": "id" }, "account": { "type": "id" }, "replyText": { "type": "text" } }, "key": ["commentId", "account"] },
  "bindings": { "commentId": { "record": "commentId" }, "replyText": { "request": "replyText" } }
}
```

The field types are `id`, `text`, `path`, `url` and `timestamp`:
- `id` is opaque and compared byte for byte.
- `text` keeps newlines verbatim.
- `url` must stay on an allowed origin: a supplied URL never widens what a run may reach.

`journey chain` (and MCP `chain_journeys`) checks the contracts before any reply runs:
- incompatible contracts refuse the chain (`E_HANDOFF_INCOMPATIBLE`);
- an invalid record, an ambiguous (duplicate) key or a malformed request is listed under `rejected`
  with field-level errors and is never run;
- params come only from the bindings.

Each run is stamped with the contract, a `sha256:` fingerprint of the record and its capture time.
Errors and results never contain text, URL or path values. A Journey without contracts chains as it
did in 0.17.0. Contracts are part of the Journey's content hash, so changing one requires re-review.

Checking a contract is not live verification. A well-typed but stale record still reaches the reply
Journey, whose own checks must refuse it before anything is written.

## Prepare-only handback (#583)

A Journey that prepares something and stops before a person acts declares the boundary:

```json
"boundary": {
  "kind": "prepare-only",
  "stopBefore": { "target": { "testId": "reply-send" }, "label": "Send" },
  "nextStep": "Read the prepared reply in Community, then click Send yourself."
}
```

These are refused at load:
- a click on `stopBefore`;
- an `Enter` press;
- any click after the last fill or select;
- a `handback` step.

Self-heal is refused before a browser opens (`E_BOUNDARY_NO_HEAL`). During the run every first-party
write is counted; with `"blockWrites": true` each write is also aborted. Every run reports one state:

| `handback.state` | Meaning | Exit |
| --- | --- | --- |
| `prepared` | every check passed and no write was sent; the next step is shown | 0 |
| `verification-failed` | a check failed (`failedAt` names the step) | 1 |
| `incomplete` | the run ended before the boundary for another reason | 1 |
| `inconclusive` | no verdict (degraded host, or write observation unavailable) | 2 |
| `submitted` | a write was sent (or attempted) during the run, whatever else happened | 1 |

```
handback: prepared — next: Read the prepared reply in Community, then click Send yourself.
```

Code decides the state from the run's own results and network evidence; a model's claim never sets
it. Writes are observed on the Journey's page. A popup or second tab the app opens is not observed.

## One readiness receipt (#581)

```bash
jevitate journey readiness discover-conversations --with prepare-reply              # report: no browser
jevitate journey readiness discover-conversations --with prepare-reply \
  --mode replay --env local --requests approved.jsonl                               # plus the chain
jevitate journey readiness prepare-reply --mode prove --env local --param …         # plus verify --mutate
```

The receipt covers these checks, each per Journey: lint, schema, handoff (pair only), boundary, strict
review, annotations, catalog links and approvals, the recorded mutation proof, replay and promotion.
Each check reports one state:

- `pass`, `fail` or `inconclusive`;
- `stale`, when the evidence is bound to older content;
- `not-run`;
- `awaiting-human`.

The verdict is computed in this order: `blocked` (any fail), then `inconclusive`, then `incomplete`
(the proof is stale or missing, or the replay did not run in `replay`/`prove`), then
`technically-ready`. A passing replay never hides an inconclusive proof. Approvals are listed under
`awaitingHuman` and are never acted on.

`report` mode opens no browser and sends nothing. `replay` and `prove` refuse three things before
any browser opens: a missing target, an environment flagged `production: true`, and missing params
(named, never shown). In a pair's `prove` mode, the consuming Journey is verified with the params you
pass; if they do not cover it, its proof shows the refusal as `not-run`.

The receipt carries no param value, page text, secret or full URL. Exit codes: 0 technically-ready,
1 blocked, 2 inconclusive or incomplete. Over MCP the same command is `journey_readiness`.

## The human review bundle (#584)

```bash
jevitate journey bundle discover-conversations --with prepare-reply --out review/
jevitate journey bundle --check review/            # E_BUNDLE_STALE when anything moved
```

The bundle is `bundle.md` plus `manifest.json`, built from a `report`-mode readiness and the review
sheets. The verdict, blockers and any inconclusive or stale proof come first. Then, per Journey:
- contracts (names and types);
- the boundary and its next step;
- side effects;
- hashes and objectives;
- approval states, each labelled distinctly (technically ready, draft, prior approval, stale
  approval, current authorization).

It ends with the ordered human-only commands. `journey promote` carries the review hash only when
the workflow is technically ready; otherwise it is listed without a hash under "After the blockers
are fixed".

`--check` re-derives every hash, so a stale bundle fails closed. The bundle stays local and holds no
values, page text or secrets. It cannot approve, promote, waive or authorize anything. The exit code
follows the readiness verdict. Over MCP the command is `journey_bundle`, which writes only inside
the project.
