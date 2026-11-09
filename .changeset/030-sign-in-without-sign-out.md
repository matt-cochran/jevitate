---
"@jevitate/cli": patch
"jevitate": patch
---

A sign-in goal now ends succeeded when the app signs the run in but shows no sign-out or account control: a page that offered a sign-in control before the run typed its credentials, and offers none after, counts as the code-observed sign-in (the advisory scope check still decides that the whole goal is signing in). Before, such a run idled and ended blocked "answer not found" although the app had signed it in.
