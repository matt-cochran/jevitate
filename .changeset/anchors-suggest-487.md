---
"@jevitate/cli": minor
---

Anchors without hand-editing JSON (#487): `jevitate journey anchor add|remove` edit a draft Journey's
anchors (the step id is written at once), `journey lint --fix` stamps number-only anchors, and
`journey anchors <id> --suggest` proposes anchors where the recorded flow changes state (a new page,
a form that became valid, a completed write) with default probes and the `anchor add` command to
accept each. `journey anchors` also lists each anchor's `stepId`.
