---
"@jevitate/cli": minor
---

`explore --from-journey <id> --at-step <anchor|n>` now accepts `--fixtures`, `--before` and `--after` with any anchored strategy (#312). Before, only goal runs did. The step runs as a one-stop campaign, between the setup and the restore, and the result has the sweep's shape (`sweep.mode: "step"`). Runs without `--from-journey` still need `--strategy goal` for fixtures.
