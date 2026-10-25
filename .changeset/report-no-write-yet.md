---
"@jevitate/cli": patch
"jevitate": patch
---

A write goal that stalls before any write of the run succeeded is now told no write was made yet, on a rejected `report` and on the no-progress last chance, as a rejected `done` is since #667, so the run spends its last turn going back to submit the change instead of on a report that must be rejected (#680).
