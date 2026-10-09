---
"@jevitate/cli": patch
"jevitate": patch
---

Goal runs now notice inline validation text that appears in the form they just acted on, even without `role=alert` (#446). After the action, the model is told what the form now shows, the message stays in its page status while the page shows it, and the step counts as an observed change. If the run stops without getting past it, the outcome reason names the message ("the form shows "Domain cannot contain spaces" after click Create") instead of a bare "no progress".
