---
"@jevitate/cli": minor
"jevitate": minor
---

`journey verify --mutate`: a proof with no pairs now says what to add. A `networkChecks` entry that names a POST on a Journey with no recorded write reads `inconclusive` as before, and the reason names the check and says: if this request is the step's write, add it to that step's `delta.requests`, or add the `metadata.mutationPairs` entry it spells out. Verdicts don't change.
