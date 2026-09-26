---
"@jevitate/cli": minor
"jevitate": minor
---

One versioned result schema across explore strategies (#195). Every goal, coverage, exploratory, adversarial, feature and usability result now carries `schemaVersion: 1`, `strategy`, `missionOutcome`, `exitCode`, `defects`, `hangs`, `recordingPaths`, `transcriptPath`, `resultPath`, `target` and `engine`, filled the same way by every strategy. `defects` now holds every defect, `server-log` ones included; a usability run's server-log defects are marked `advisory: true` and still never gate its outcome. `recordingPaths` is always an array. Persisted results now always include `resultPath`. The schema is exported as `MissionResultSchema`, `PersistedMissionResultSchema` and `MissionResultCore` (see docs/results.md). Deprecated for 0.2.0 only and removed in the next minor: `serverLogDefects` (use the `server-log` entries in `defects`) and `recordingPath` (use `recordingPaths[0]`).
