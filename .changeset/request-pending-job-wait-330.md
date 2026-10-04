---
"@jevitate/cli": patch
"jevitate": patch
---

With `--job-wait-ms`, a request that is still pending while the page shows an in-progress status (a `role=status` "Designing variations…") is waited out within that budget instead of being reported as a `request-pending` hang at 15 s (#330). Without the flag, a bare status still isn't enough (#153), as before. A live region whose text is "<verb>ing … …" now counts as an in-progress status even when the verb isn't in the built-in list.
