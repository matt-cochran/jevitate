---
"@jevitate/cli": patch
"jevitate": patch
---

A status that never completes no longer eats the whole decision budget (#328). If the page still shows the same kind of in-progress status ("Preparing QR…") once the job-wait budget is spent, and none of the run's requests is in flight, the next `wait` ends the run as `no-progress`. The reason names the stuck status and the budget, instead of the run going on until `exhausted` (120 decisions, 1 action). Raise `--job-wait-ms` for a job that legitimately takes longer.
