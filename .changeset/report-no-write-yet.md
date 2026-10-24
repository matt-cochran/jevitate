---
"@jevitate/cli": patch
"jevitate": patch
---

A rejected `report` on a write goal before any write of the run succeeded now says no write was made yet, as a rejected `done` does since #667, so a run that wandered past a wizard's final step is steered back to it instead of looking for an answer (#680).
