---
"@jevitate/cli": patch
"jevitate": patch
---

With an explicit `--job-wait-ms`, a busy region the app declares (`aria-busy="true"`) is waited out within that budget instead of ending as a `ui-no-progress` hang at the render ceiling (#687). A hang that stands before the budget is spent no longer says it is past the budget: its detail gives the budget used, the wall-clock time since the first deferral and when the app last completed a request (#689). `--ignore-no-progress` also matches a busy indicator's visible words, not only its description (#687).
