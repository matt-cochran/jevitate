---
"@jevitate/cli": minor
"jevitate": minor
---

`journey verify --mutate`: "a write still unanswered" now names the replay that had it open and the write. It blamed a mutation such as `skip:2` even when only the independence replay or a control had run, and neither applies a mutation.
