---
"@jevitate/cli": minor
"jevitate": minor
---

Host starvation is classified, not blamed on the app (#452). A run that stalled while the host showed starvation (event-loop lag, slow browser (CDP) round-trips, page loads far slower than the run's own baseline) ends `inconclusive` with `failure.kind: "host-starved"` and the measurements; `degraded-environment` is unchanged. `jevitate sweep` counts it as an environment failure and retries a starved target once after a bounded wait for load to drop (`--no-host-starved-retry` to disable). `JEVITATE_HOST_STARVATION=off` turns the classification off.
