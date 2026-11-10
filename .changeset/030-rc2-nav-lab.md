---
"@jevitate/cli": patch
"jevitate": patch
---

RC2 navigation lab fixes. A goal run that gives up below the no-route coverage floor, while it can still open an unopened page or try an untried safe control, is deferred (at most 3 times, each after an action) with a hint naming what is left; the floor still decides `no-route-found`. A page that hides a link to an unopened page or a button (a hover or collapsed menu) is now below the floor, so a hidden route never reads `no-route-found`. A blocked, stalled or exhausted goal run that does not end `no-route-found` names why in `noRouteShortfall`. With `--job`, a pass whose done check reads false now reports `goalOutcome: "failed"`, `goalReason: "done-check-failed"` (exit 1 as before), and a run that gave up or ran out of budget while its done check read false before and true after is the job done: `goalOutcome: "succeeded"`, exit 0 (job gates, the model's ending is advisory).
