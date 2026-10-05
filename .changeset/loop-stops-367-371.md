---
"@jevitate/cli": patch
"jevitate": patch
---

A goal run that goes round a loop now stops as `no-progress` instead of burning its whole decision budget (#367): clicking back and forth between two controls (a link and its Back link, a disclosure toggled open and shut) or scrolling up and down between the same positions, four times over with no request sent and nothing new on the page, ends the run with the loop named in its reason. A scroll that did not move no longer restarts the moving-scroll bound, and progress that makes a request, reveals a new state or changes a value is never counted as a loop. A no-progress reason's `last blocker` now names the latest failed or rejected action (e.g. `type "Your answer" rejected: …`), not a stale blocker from an earlier screen (#371).
