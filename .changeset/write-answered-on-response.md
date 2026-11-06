---
"@jevitate/cli": minor
"jevitate": minor
---

`journey verify --mutate` now treats a write as answered once its response has arrived. A POST answered with `Cache-Control: no-store` whose body the page does not read never reports that it finished, so a proof read `inconclusive` ("a write still unanswered") about a request answered in milliseconds; those proofs can now reach a verdict. A write with no response stays open and still taints the proof. A body that has not ended gets 2s more, then counts as answered: it can't be told from one nobody reads, and a late effect is caught like a job that outlives its response. A block-write now also notices its write being answered after the block when the body is unread. `journey run`: a `responseStatus` check on such a request now reads its status instead of failing with "still awaiting a response"; a gRPC-web or Connect response still waits for its body, since its result can be in the trailer.
