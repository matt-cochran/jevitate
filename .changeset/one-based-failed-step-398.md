---
"@jevitate/cli": patch
"jevitate": patch
---

`journey run`, `check` and a stale `--from-journey` prefix now name the failed step 1-based, the same way the rest of the output counts steps (#398). Before, "step 2 failed" meant the third step.
