---
"@jevitate/cli": minor
"jevitate": minor
---

A goal run's `goalOutcome` is now only about the goal: a defect such as an HTTP 5xx, a server-log error or a violated invariant no longer replaces it. Defects are reported separately in `defectOutcome`, and a goal that was not achieved carries a structured `goalReason` (`not-found`, `ungrounded`, `blocked-by-policy`, `budget`, `hang`, …). `missionOutcome` is derived from both by one documented table, and every exit code stays the same. MCP `get_mission_result`, `jevitate report` and the human output show both verdicts.
