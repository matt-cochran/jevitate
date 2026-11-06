---
"@jevitate/cli": minor
"jevitate": minor
---

`journey verify --mutate --resume` now runs an errored pair again instead of reusing it, so one errored replay no longer means starting a long proof over. It also accepts a proof that finished `inconclusive` on errored replays and nothing else; any other finished proof is still refused with `finished`. `--status` says which. A pair that skipped its control because the verdict looked decided also runs again, so a repaired error can't leave an unvouched reading to turn the proof `proven`. A failed fixture restore now also stops a targeted proof and a sibling re-run at once, rather than after their next replay. `--status` `completed` now counts only what a resume keeps, with `toRunAgain` beside it. A pair run again sends its real writes again. A replay that stalls with a write open, or whose close never finished, now leaves the proof `inconclusive` on resume, as one that throws does, and the `finished` refusal of such a proof says to rerun with plain `--mutate`.
