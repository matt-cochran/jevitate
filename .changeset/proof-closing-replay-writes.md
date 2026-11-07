---
"@jevitate/cli": minor
"jevitate": minor
---

`journey verify --mutate` now runs a closing replay as recorded, last, when the verdict could still change, and that replay has to pass. Like every replay it sends real writes, so a proof on a target you can't reset leaves more behind than it did in 0.28. It's counted in `--plan`'s `minimumReplays`.
