# Prepare-only handback contract (#583)

Status: contract for 0.18.0. A Journey can declare that it ends at a verified human handback: it
prepares something (a reply in a composer) and stops before the action a person takes (Send). The
run then reports a typed handback state. It is not a second sending mechanism, and it grants nothing.

## 1. Declaration: `metadata.boundary`

```json
"boundary": {
  "kind": "prepare-only",
  "stopBefore": { "target": { "testId": "reply-send" }, "label": "Send" },
  "nextStep": "Read the prepared reply in Community, then click Send yourself.",
  "blockWrites": false
}
```

| Field | Meaning |
| --- | --- |
| `kind` | `"prepare-only"` (the only kind) |
| `stopBefore` | the control a person uses next: a target descriptor and a label. It is never acted on |
| `nextStep` | the exact human next step, shown wherever the state is shown (1–500 chars) |
| `blockWrites` | optional. `true` aborts every first-party write request during the run (the #402 write guard), so nothing can be submitted even by the page itself. Default `false`: writes are observed, not blocked |

Optional and additive: a Journey without `boundary` runs and reports exactly as before.

## 2. Load-time rules (refused with `E_BOUNDARY_SCHEMA` issues)

A Journey with a `prepare-only` boundary may not contain:

- a `click` (top level or in a `forEach`) whose target equals `stopBefore.target`;
- a `press` of `Enter` (or `NumpadEnter`) on any target;
- a `click` after the last `fill`/`editText`/`select` (nothing is clicked once the value is prepared);
- a `handback` step (the boundary IS the handback).

## 3. Run-time rules

- Self-heal is refused for a Journey with a prepare-only boundary (`E_BOUNDARY_NO_HEAL`, exit 64),
  before any browser opens. A changed account, target, text or context therefore fails closed; a
  retarget can only be proposed through the existing reviewed heal-revision flow on the CLI, never
  applied during the run.
- The run never resumes past the boundary, never presses Enter and never clicks `stopBefore`.
- Every first-party write request the page sends during the run is counted (the same classifier as
  `journey lint`'s write steps). With `blockWrites`, each is aborted and still counted.

## 4. Result: `handback`

`journey run` (CLI `--json` data, MCP `run_journey`) gains, only when a boundary is declared:

```json
"handback": {
  "state": "prepared",
  "boundary": "prepare-only",
  "stopBefore": "Send",
  "nextStep": "Read the prepared reply in Community, then click Send yourself.",
  "evidence": { "steps": 9, "checksPassed": 9, "writes": 0, "writesBlocked": 0 }
}
```

| `state` | When | Exit |
| --- | --- | --- |
| `prepared` | the run is `ok`, every step and its check passed, and **zero** writes were sent | 0 |
| `verification-failed` | a step's own postcondition or an assertion failed (wrong conversation, account, context or text); `evidence.failedAt` names the step | 1 |
| `incomplete` | the run ended before the boundary for another reason (navigation, target not found, awaiting a person elsewhere, a policy refusal); `evidence.failedAt` when known | 1 |
| `inconclusive` | the run's outcome is `inconclusive` (host degraded, resource limit), or write observation was unavailable | 2 |
| `submitted` | one or more writes were sent (or, with `blockWrites`, attempted) during the run, whatever else happened | 1, error code `E_HANDBACK_SUBMITTED` |

`submitted` wins over every other state. `prepared` is decided by code from the run's own results
and network evidence; a model's claim never sets or changes it. `nextStep` is shown only with
`prepared`; any other state shows what failed instead.

The human-readable `journey run` output ends with one line:

```
handback: prepared — next: Read the prepared reply in Community, then click Send yourself.
```

## 5. Where it appears

`journey run` (CLI and MCP), `journey chain` (per run, `runs[].handback`), readiness (#581) and the
review bundle (#584). `journey review` shows the declared boundary. The boundary is part of the
Journey file and its content hash: changing it requires re-review.

## 6. Not in scope

Approval of the prepared content (Bizops owns copy approval), sending, resuming, and production
browser execution.
