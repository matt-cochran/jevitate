---
"@jevitate/cli": minor
"jevitate": minor
---

`journey verify --mutate --resume` now runs an errored pair again instead of reusing it, so one errored replay no longer means starting a long proof over. It also accepts a proof that finished `inconclusive` on errored replays and nothing else; any other finished proof is still refused with `finished`. `--status` says which. A failed fixture restore now also stops a targeted proof and a sibling re-run at once, rather than after their next replay.
