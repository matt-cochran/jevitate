---
"@jevitate/cli": patch
"jevitate": patch
---

`journey verify --plan` and the proof's report now say plainly when no reset hook or fixture is set, with how many of the planned replays can send real writes (`summary.writeReplays`, and `noReset` in `--json`).
