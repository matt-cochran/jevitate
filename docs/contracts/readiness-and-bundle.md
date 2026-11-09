# Readiness and review bundle contract (#581, #584)

Status: contract for 0.18.0. Two commands over a Journey or a linked pair. Both reuse what exists
(`journey lint`, `journey review` and its `--readiness` checks in `readiness.ts`, the `.verify/<id>.json`
proof record bound to the review hash, `journey run` / `journey chain`, `journey verify --mutate`,
catalog review and link resolution). Neither adds a proof, an approval or an authority.

## 1. `jevitate journey readiness <id> [--with <toId>]`

| Flag | Meaning |
| --- | --- |
| `--with <toId>` | a linked pair: `<id>` produces, `<toId>` consumes (#582 handoff checked) |
| `--mode report\|replay\|prove` | default `report` |
| `--env <name>` / `--base-url <url>` | the target; **required** for `replay` and `prove` |
| `--param k=v`, `--requests <file>` | inputs for `replay`/`prove` (`--requests` for a pair, as `journey chain`) |
| `--storage-state`, `--fixtures` | as `journey run` |
| `--secret-field <binding>` | `replay`/`prove`: a secret parameter from the environment, as `journey verify` (#827); the target's `targets.json` `secretFields` apply too. Over MCP, `journey_readiness` reads only `targets.json` |
| `--project`, `--journeys-dir` | locations (#585) |
| `--json` | the receipt (§3) as the envelope's data |

Modes:

- **`report`** (default): opens no browser and sends nothing. It runs only static checks and reads
  existing evidence.
- **`replay`**: `report`, plus the baseline replay. One Journey: `journey run`. A pair: `journey chain`
  (needs `--requests`).
- **`prove`**: `replay`, plus `journey verify --mutate` on each Journey. Fresh proofs are recorded as
  `verify` records them.

Before any browser opens, `replay` and `prove` refuse: a missing target (`E_READINESS_TARGET`, 64); an
environment flagged `production: true` (`E_READINESS_PRODUCTION`, 64); a missing required param, by
name only (`E_READINESS_PARAMS`, 64). The human summary states what the mode will do ("replays 2
Journeys against <origin>; writes are observed, nothing is approved") before doing it.

## 2. Checks

Each check is reported per Journey with one state:

| State | Meaning |
| --- | --- |
| `pass` | ran (or fresh evidence exists) and held |
| `fail` | ran and did not hold |
| `inconclusive` | ran without a verdict (an inconclusive proof, a degraded host) |
| `stale` | evidence exists but is bound to an older content/review hash |
| `not-run` | no evidence and this mode does not produce it |
| `awaiting-human` | only a person can move it (an approval, a promotion) |

| Check | Source | Static (`report`) |
| --- | --- | --- |
| `lint` | `lintJourney` + `lintUploadFixtures` (errors fail, warnings pass with notes) | yes |
| `schema` | the Journey loads, including #582 `outputs`/`inputs` and #583 `boundary` | yes |
| `handoff` | pair only: #582 compatibility (`E_HANDOFF_INCOMPATIBLE` fails) | yes |
| `boundary` | the Journey declares a prepare-only boundary (absent: `not-run` with a note; never a fail) | yes |
| `review-strict` | `journey review --strict` attention items (each one is a blocker), except an item only a person's approval settles ("Changed since approval", "Catalog links need re-review"): that one is `awaiting-human`, listed under `awaitingHuman` with `jevitate journey promote <id> --reviewed-hash <hash>` or `jevitate job\|persona review <id>`, never a blocker pointing back to strict review (#808). `journey review --strict` itself still exits 1 | yes |
| `annotations` | every step has an objective; a pending draft is `awaiting-human` | yes |
| `catalog` | the job/persona links resolve; `draft`/`stale` approvals are `awaiting-human` | yes |
| `job` | the review sheet's `job` (the latest `journey-run-*.json` of this Journey's executable content): `achieved` passes; `not-achieved` fails; `unverified` is `not-run` (no run of this version: `no-run`, `earlier-version`) or `inconclusive` (any other basis) under `doneCheckPolicy: require`, with a blocker naming the reason and the fix. Under `advisory`, or on a `harness` target, it is `not-run` with `advisory: true` | reads |
| `proof` | `.verify/<id>.json`: `sensitive` passes, `insensitive` fails, `inconclusive` stays inconclusive, a hash mismatch is `stale`, none is `not-run`. One exception: a read-only Journey that takes no input, whose proof paired nothing (only unpaired checks), passes — nothing a mutation could break. Under `mutationProofPolicy: advisory` (the default) every state, `inconclusive` included, carries `advisory: true` and no blocker. A stale detail names its cause (`staleCause`, #816) | reads |
| `replay` | the run (or chain) outcome, plus the #583 handback state when declared (`prepared` passes; `submitted` fails) | `replay`/`prove` only |
| `promotion` | promoted with a current approval passes; a draft or stale approval is `awaiting-human` | yes |

A check object may carry `advisory: true`: the check is shown but not counted by the verdict. A `job` blocker's
fix comes first in `next`, whatever the verdict.

Evidence reuse: a proof record is reused only while its bound hash equals the Journey's current
review hash (the existing rule). A changed step, assertion, contract or boundary makes it `stale`.
`report` never reruns anything to refresh it.

## 3. Receipt

```json
{
  "engine": { "version": "0.18.0", "commit": "…", "tree": "…" },
  "mode": "report",
  "target": { "origin": "http://127.0.0.1:41733", "env": "local" },
  "journeys": [{ "id": "prepare-reply", "contentHash": "sha256:…", "reviewHash": "…", "promoted": false }],
  "checks": [{ "check": "proof", "journey": "prepare-reply", "state": "pass", "detail": "proven 9/9", "evidence": ".jevitate/journeys/.verify/prepare-reply.json" }],
  "verdict": "technically-ready",
  "blockers": [{ "check": "lint", "journey": "discover-conversations", "why": "…", "next": "jevitate journey lint discover-conversations" }],
  "awaitingHuman": [{ "check": "catalog", "journey": "prepare-reply", "item": "job:answer-community-comments (draft)", "next": "jevitate job review answer-community-comments" }],
  "next": ["jevitate journey readiness prepare-reply --mode prove --env local"]
}
```

`verdict` is computed by code, in this order:

1. Advisory checks are skipped.
2. Any `fail` gives `blocked`.
3. Otherwise, any `inconclusive` gives `inconclusive`. A passing replay never hides an inconclusive
   proof that gates.
4. Otherwise, any required `stale` or `not-run` gives `incomplete`. The required checks are `job` and
   `proof` (unless advisory) in every mode, and `replay` in `replay`/`prove`.
5. Otherwise the verdict is `technically-ready`.

`awaiting-human` never changes `verdict`; it is listed separately. A receipt never contains a param
value, page text, a secret or a full URL (origins only).

Exit codes: `technically-ready` 0, `blocked` 1, `inconclusive` / `incomplete` 2.

Changes in 0.30.0 (`journey readiness`, `journey review --strict`):

| Case | 0.29.0 | 0.30.0 |
|---|---|---|
| readiness, no proof, advisory | 2 incomplete | 0 (if the job passes) |
| readiness, stale proof, advisory | 2 incomplete | 0 |
| readiness, insensitive proof, advisory | 1 blocked | 0 |
| readiness, unwaived inconclusive proof, advisory | 2 | 0 |
| readiness, latest run job not-achieved | — | 1 blocked |
| readiness, job unverified, `doneCheckPolicy: require` | — | 2 (incomplete / inconclusive) |
| readiness, stale approval only (#808) | 1 blocked | 0, `awaitingHuman` |
| review --strict, stale or insensitive proof, advisory | 1 | 0 (○ line) |
| review --strict, latest run job not-achieved | — | 1 |

Unchanged: the `require-*` policies, except that a receipt with no engine no longer satisfies
`require-sensitive`, and `review --strict` on a stale approval (still 1).

## 4. `jevitate journey bundle <id> [--with <toId>] --out <dir>`

The bundle is local and is never uploaded. It writes `<dir>/bundle.md` and `<dir>/manifest.json` from
a `report`-mode readiness, so it opens no browser:

- **Per Journey:** goal, persona/job with approval state, #582 contracts (field names and types only),
  #583 boundary and next step, side effects (its write steps), content and review hashes, step
  objectives and draft annotations, and the readiness checks with evidence paths and freshness.
- **Conspicuous at the top:** the verdict, every blocker, and any `inconclusive` or `stale` proof.
- **Human-only commands, in order:** persona approve, job approve, annotations approve, journey
  promote. Each carries the hash from the exact sheet it reads (`--reviewed-hash`). While any technical
  blocker remains, the promote commands are listed under "after the blockers are fixed" **without** a
  hash, never as ready.
- **Approval states:** technical readiness, draft catalog entries, prior approval, stale approval and
  current authorization are distinct, labelled lines.

`manifest.json` records every hash the bundle was built from. `jevitate journey bundle --check <dir>`
re-derives them and exits 1 with `E_BUNDLE_STALE` (naming what changed) when any differ: a stale
manifest fails closed.

The bundle carries no credentials, param values, page or conversation text. Only the bounded,
redacted evidence the existing sheets already show goes in, with masked media referenced by path. A
bundle cannot approve, promote, waive strict review or authorize sending: it only prints commands that
a person runs.

## 5. MCP

These are read-only tools mirroring the commands:

- `journey_readiness`: all modes. A target comes only from `env`/`baseUrl`, as `run_journey`; an
  environment flagged `production` is refused.
- `journey_bundle`: `out` is a project-confined path, as `export_catalog_bundle`.

Neither tool approves or promotes; `promote_journey` stays a separate, human-gated tool.
