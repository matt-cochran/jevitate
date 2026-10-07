---
"@jevitate/cli": patch
"jevitate": patch
---

`jevitate load run` now judges each iteration exactly as `journey run` does: a Journey's end-state checks (`metadata.endState`, then legacy `networkChecks`) and each step's `expectRequests` are evaluated, so an iteration whose checks fail is counted as quarantined, not ok (#400). A Journey without checks behaves as before.
