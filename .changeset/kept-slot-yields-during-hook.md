---
"@jevitate/cli": patch
"jevitate": patch
---

A `journey verify --mutate` proof now gives up its kept machine slot to a run that starts waiting while a hook runs between replays. It looked only at a session's close and at the next open, so a long hook could push the other run past its admission limit.
