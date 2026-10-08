---
"@jevitate/cli": minor
"jevitate": minor
---

Backend log lines that match `--log-defect` are now classified by a per-project `.jevitate/log-classes.json` and built-in rules. A placeholder or invalid API key, an unconfigured provider or a degraded health check counts as an environment fault, listed under `environmentFaults` and in `jevitate report`, and is not a defect. Lines classed `expected-validation` are recorded in `expectedValidation` without failing the run.
