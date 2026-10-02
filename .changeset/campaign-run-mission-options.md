---
"@jevitate/cli": minor
---

`campaign run` now forwards explore's mission options to every anchored mission (#311). These are `--allow-destructive`, `--allow-writes`, `--deny`, `--paid`, `--invariants`, the backend-log flags (`--log-source`, `--log-defect`, `--log-scope`, `--log-correlation-header`, and the rest) and `--evidence-video`, `--record-video` and `--screenshots`. MCP `run_campaign` takes the safety and media flags; log sources and hooks stay operator-only. `--hook-timeout-ms` now reaches the hooks of a campaign spec and of an `--at-step all|anchors` sweep. Before this change it was silently dropped, so those hooks always used the 60 s default.
