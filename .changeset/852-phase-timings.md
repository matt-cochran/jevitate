---
"@jevitate/cli": minor
---

`journey run --json` and every run item in `check.json` report `timings`, which says where the run's wall time went (#852).
- **Phases:** `prepare`, `siteGate`, `fixtures`, `login`, `browserOpen`, `stepAction`, `stepCheck`, `stepPace`, `doneCheck`, `teardown` and `report`.
- **Self time:** each phase is charged its own time only, so the phases never double-count.
- **`unattributedMs`:** the time no phase claimed. On a 3-step Journey with a done check it is under 5% of the total.

See [Run timings](docs/results.md#run-timings-timings-852).
