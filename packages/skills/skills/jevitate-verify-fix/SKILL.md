---
name: jevitate-verify-fix
description: Reproduce a jevitate finding by its fingerprint and prove a fix (`jevitate verify-fix`, MCP `verify_fix`); attach evidence (`--evidence-video` clips, `--record-video` before/after, `--screenshots`); keep findings re-checkable (`jevitate ledger`); lock a bug in as a committed regression (`jevitate regression capture|run`). Use after a run reports a defect, when fixing one, or when a PR needs proof a bug is gone. Not for finding new bugs (jevitate-explore).
---

Every finding jevitate reports has a stable `fingerprint` and its own reproduction: the Recording
and the step to replay up to. Your job is to replay it, read the verdict literally, and attach
the evidence. No model decides any of these verdicts.

## Reproduce or verify a fix

- CLI: `jevitate verify-fix --result <run>.result.json --fingerprint <fp> [--replays 3] --json`.
  The result file is `<stem>.result.json` beside the run's Recording (under `.jevitate/logs/<date>/`
  by default). The fingerprint is from the result's `defects[]` (or `hangs[]`).
- MCP: `verify_fix({ id, fingerprint, replays?, recordVideo?, screenshots?, storageState? })`,
  where `id` is the result stem (e.g. `adversarial-2026-09-23T00-00-00-000Z`) or a finished
  `queue_exploration` missionId.
- Verdicts and exit codes: `fixed` (0, the signal was absent on every replay) · `still-reproduces`
  (1) · `inconclusive` (2, a replay couldn't reach the step, e.g. a missing session or a changed
  page) · `intermittent` (4, it fired on some replays) · 64 (unusable input). Only `fixed` means
  fixed. A single clean replay isn't evidence, so never lower `--replays` below 3 to make a check
  pass.
- An authenticated app needs `--storage-state <file>` (a path, never cookie contents), or the
  target's session in `~/.jevitate/targets.json`. A finding recorded at a viewport or device
  replays at that emulation. `--viewport`/`--device` that differ are refused unless
  `--allow-emulation-override` is passed.

## Evidence for a PR or an issue

- At discovery, add `--evidence-video` to `jevitate explore` (or `mission queue`). Each defect
  (up to 5) then gets a captioned clip of its minimal repro with the failing step marked by the
  real signal, plus before and at screenshots, under `<run>.evidence/<fingerprint>/`. The result
  gets `defects[].evidence`, and the issue drafts link to them.
- At fix time, `jevitate verify-fix ... --record-video` writes the before/after pair:
  `evidence.before` (the run's own clip) and `evidence.after` (a captioned replay now, ending on the
  verdict).
- `--screenshots [screens|steps|<dir>]` writes masked screenshots and an `index.md`. It works on
  `explore`, `verify-fix`, `journey run` and `mission queue`.
- Secrets are masked in pixels. A capture whose mask can't be proven isn't written
  (`screenshotsSkipped`/`captureSkips` say why). Report that. Never work around it.
- Link to the files. GitHub's API can't upload media, so commit them under `.jevitate/` or
  publish them as CI artifacts.

## Keep it re-checkable: the ledger

Run output under `.jevitate/logs/` is pruned by retention. To re-check a finding months later:

- `jevitate ledger add <run>.result.json <fp> [--ticket JEV-123] --json` stores the repro material
  (no sessions, no page text) in `.jevitate/regressions/ledger/<fp>.json`. Commit it with the fix.
- After that, `jevitate verify-fix <fp> --json` works without `--result`, and
  `jevitate ledger verify [--ticket JEV-123] --json` re-checks every entry. It exits with the worst
  verdict. An empty match is exit 2 ("nothing verified"), never a pass.
- Over MCP, the `ledger` tool takes `add`/`list`/`verify` as its action.

## Lock it in: a committed regression

- `jevitate regression capture --from <run>.json --result <run>.result.json [--fingerprint <fp>]
  --id <id> --json` replays the failure `--attempts` times (default 3) and commits
  `<id>.recording.json` and `<id>.meta.json` to `.jevitate/regressions/`. A failure that doesn't
  reproduce every time is labeled flaky and isn't committed. It captures a failed goal `--success`
  check (minimized), an app-caused failed action, a failed network check, a declared-invariant
  violation, or a Recording whose last `expect` fails.
- A hard-signal fingerprint (HTTP 5xx, a hang, a server-log defect) is refused (64) with a pointer
  to `ledger add`/`verify-fix`. To make one a regression, declare the rule it breaks as an
  invariant (`--invariants`) and capture the invariant violation.
- `jevitate regression run <id> [--env <name>] --json` exits 1 (`reproduces`) while the bug is
  there and 0 (`fixed`) once it's gone. An existing `--id` is refused unless `--force` is passed.
  Only overwrite when the human asks.
- MCP: `regressions` with `action: "capture"` or `action: "run"`.

## What you must never do

- Never report `inconclusive` or `intermittent` as fixed, and never retry until you happen to get a
  clean replay.
- Never edit a result file, a ledger entry or a committed regression to change a verdict.
- Never capture or commit a regression the human didn't ask for. Recommend it and say why.
