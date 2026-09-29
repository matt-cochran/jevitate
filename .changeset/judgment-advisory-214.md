---
"@jevitate/cli": patch
"jevitate": patch
---

A state flagged only by Jev's judgment is advisory (#214). In coverage and exploratory runs, a `judgment-flagged-state` defect now carries `advisory: true` in `defects` and `coverage.defects`. It keeps its repro Recording, so `verify-fix` can still replay it, but it never sets `missionOutcome` or the exit code on its own. A run whose only finding is a flagged state now ends `clean`, or `inconclusive` when it exercised too little; before, it ended `defects-found` with exit 1. The run is `defects-found` only when an independent code oracle confirms a defect: an HTTP 5xx, a horizontal overflow, a declared invariant or a server-log defect. `check` and `report` read a flagged state as an advisory finding, the same as before, and the human summary counts it as advisory.
