---
"@jevitate/cli": minor
"jevitate": minor
---

HTTP 5xx is a hard-signal defect in every strategy (#208). Goal, feature, coverage/exploratory and usability runs now record a 5xx from the app's own origins as an `http-5xx` defect in `defects`, with the same fingerprint the adversarial strategy gives it (endpoint pattern + status), so `verify-fix` replays it the same way. A goal run whose success checks held but whose run hit a 5xx ends `defects-found` (exit 1), never `succeeded`: `assertionPassed`/`checks` keep the checks' verdict and `reason` names the failing request (`PUT /demo/api/profile → 500`). An adversarial run whose start page itself answers 5xx reports that as an `http-5xx` defect (`defects-found`, `stop: "not-rendered"`) instead of an inconclusive "not rendered". A 5xx from a third-party origin (#194) is not the app's defect, in every strategy. In a usability run the defect is listed with `advisory: true`, like its `server-log` defects.
