---
"@jevitate/cli": patch
"jevitate": patch
---

`journey verify --resume` now accepts a proof that ended `inconclusive` because its independence replay errored. It runs that replay again against the base it re-measures, as every resume does, so an old result is never read; another error leaves the proof `inconclusive`. A proof whose replays crossed state, or whose fixture restore failed, still can't be resumed. (#787)
