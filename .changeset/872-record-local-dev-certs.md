---
"@jevitate/cli": patch
"jevitate": patch
---

A run that used `--accept-local-dev-cert` now records it (#872): its emitted and persisted results carry `localDevCerts`, the accepted origins, beside the run's tags and target. Absent when the flag was not used.
