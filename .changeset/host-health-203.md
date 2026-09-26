---
"@jevitate/cli": minor
"jevitate": minor
---

Tell a starved host apart from app findings (#203). Every run samples the host's health (the browser pool's admission thresholds, load average per core, the driver's event-loop lag, and the render trend against the run's own baseline), and every result now carries `hostHealth` (peak load per core, minimum free memory, peak event-loop lag, slowest render, starved steps) and `environmentDegraded`. A hang, click timeout or no-progress stop met while the host was starved is listed there as advisory, never as a defect or hang finding. A run most of whose steps ran starved is `inconclusive` with `failure.kind: "degraded-environment"`, never `clean`. A coverage or exploratory frontier that emptied because its actions timed out now ends `insufficient-exploration` (inconclusive), not `exhausted`. Both fields are additive to result schemaVersion 1. `JEVITATE_HOST_STARVATION=off` keeps the sampling but disables the attribution.
