---
"@jevitate/cli": patch
"jevitate": patch
---

`explore --job` reads its done check reliably. An `http:GET <path>` done check is now read on the run's origin; every reading of one was `reading-unknown`, since the path was never made absolute. A goal run that ends without an accepted `done` (the judgment rejected every `done`, the run was blocked, or it ended on an answer) now takes its after reading at the end, so its job reads `achieved` or `not-achieved` from the app's state instead of `reading-unknown` with nothing read. A reading that truly cannot be taken stays `unverified`/`reading-unknown`, and the goal run's `job.reason` says why (`session-unavailable`, `page-replaced`, `check-unevaluable`).
