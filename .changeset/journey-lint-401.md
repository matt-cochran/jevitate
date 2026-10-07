---
"@jevitate/cli": minor
"jevitate": minor
---

`jevitate journey lint <id>` reports the assertions that cannot prove a Journey's outcome (writes
without an asserted effect, visibility-only claims, nothing after the last write, …), as human
lines, a `--json` envelope, or a `--sarif` log CI can gate on (exit 1 when any error).

`journey promote` now runs that lint first: a weak Journey is refused until the reviewer accepts it
with `--accept-weak "<reason>"`, which is recorded on the Journey as `metadata.acceptedWeak`.
Warnings never block promotion.
