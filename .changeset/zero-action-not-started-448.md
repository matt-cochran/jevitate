---
"@jevitate/cli": minor
"jevitate": minor
---

A goal run that executed no actions reports `goalOutcome: not-started` (#448), never `succeeded`/`defects-found` as if the journey had been exercised. It maps to `missionOutcome: inconclusive` (exit 2) with a `goalReason` (`no-controls`, `auth-failed`, `preflight-failed`, `no-actions`); passively found defects are still listed. A goal that already held and is accepted with `--allow-vacuous-checks` keeps `succeeded`. `jevitate sweep` counts these runs in `summary.notStarted`.
