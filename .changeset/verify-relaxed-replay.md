---
"@jevitate/cli": patch
"jevitate": patch
---

`journey verify --mutate` no longer reports a write Journey as inconclusive when the write step's own postcondition fails first (#554). The mutation is replayed once more with that postcondition left out, so the step's `expectRequests` and the end-state checks are judged on their own.
