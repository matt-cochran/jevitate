---
"@jevitate/cli": minor
"jevitate": minor
---

A `--log-source` that opened and stayed attached but delivered zero lines no longer turns a completed mission inconclusive: zero server errors from a healthy source is evidence, not a hole in the oracle. Only a source that failed to attach or errored (including a `docker:`/`cmd:` tail process that exits non-zero on its own) degrades the run, and `serverLogs.oracleReason` now names each failed source and its error. `--log-quiet-ok` keeps working for compatibility but is redundant since 0.8.0; the silence is recorded in the new `serverLogs.quietSources`.