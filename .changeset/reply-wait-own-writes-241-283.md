---
"@jevitate/cli": patch
"jevitate": patch
---

A chat's next message is awaited while its own request is still in flight: the run's earlier turns' writes to the same endpoint are not background polling, a request held past the long-poll threshold still counts, and a later `wait` on the turn sees it. Background polls are told apart over the last minute, not only since the last step. A `--settle-ignore`d beacon is never an action's effect or a sign that a busy app is working (#241, #283, #284, #288).
