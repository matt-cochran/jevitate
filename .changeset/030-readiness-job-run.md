---
"@jevitate/cli": patch
"jevitate": patch
---

`journey readiness` counts an achieved job only from a run whose own steps passed: an `achieved` done check on a quarantined or failed run reads `unverified` (`run-not-passed`). In `--mode replay` and `--mode prove` the `job` check now uses the job verdict of the replay readiness just ran (its done check read in a fresh session, as `journey run` does), never an earlier run's; a replay that read none is `unverified` (`replay-no-verdict`).

`journey review` (and its JSON `job`) applies the same rule: a failed run's `achieved` done check shows `unverified — the latest run's own steps did not pass` (`run-not-passed`), not `achieved`.

`journey shorten --budget` is parsed when the command line is (an integer from 1 to 500, else exit 64 with commander's usage error). Catalog contract v3's Journey schema now carries `metadata.done` (a Journey's own done check), which the runtime already accepts; v1 and v2 are unchanged.
