---
"@jevitate/cli": minor
"jevitate": minor
---

Every server-log defect is now a structured entry in the result's `defects[]` with `level`, `source`, `message`, `firstSeenStep` and `count`, so tools that aggregate runs never have to parse the free-text `reason`. Every result also carries `defectOutcome` (`{status, byKind}`), which counts the run's defects by kind.
