---
"@jevitate/cli": patch
"jevitate": patch
---

A goal that asks for a report needs its answer (#286). When the goal asks the run to report what it found ("Finish by reporting the price shown") and `--success` checks are given, the checks holding no longer end the run ("goal already met" under `--success-when held`) and are not the whole verdict: the model is told to end with `report`, a `done` is rejected with that reason, and without a grounded answer the run does not succeed — `checks` gains a failing `report (the goal asks for a grounded answer)` entry. A check satisfied mid-run by an unrelated page's load-time request (a quote fired on load) previously ended such a run `clean`/`succeeded` with no price reported.
