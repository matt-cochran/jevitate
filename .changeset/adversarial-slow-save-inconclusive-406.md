---
"@jevitate/cli": patch
"jevitate": patch
---

Adversarial runs no longer judge a declared invariant on a save that is still in flight (#406). A misuse step waits up to 5 s for the writes it started to end; if one is still pending then, that step's `require`/`always` invariants are `inconclusive` (counted as unknown, never a violation and never a pass), and the transcript and the invariant report name the writes it waited on, e.g. `PUT /api/profile`. Invariants with `settle.withinMs` keep their own re-check window.
