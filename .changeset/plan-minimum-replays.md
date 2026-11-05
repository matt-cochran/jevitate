---
"@jevitate/cli": patch
"jevitate": patch
---

`journey verify --plan`'s `minimumReplays` now counts what a proof runs: the base, the independence replay, one per mutation and the closing replay. It said the base plus one per mutation, which was short by two. Relaxed and targeted replays, controls and re-runs still add to it.
