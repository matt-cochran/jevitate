---
"@jevitate/cli": patch
"jevitate": patch
---

Adversarial runs judge a declared invariant on a Save only once that save has been answered (#388). A misuse step now waits (up to 5 s) for its requests before its invariants are checked, so a rejected save is no longer reported as violating `saidSaved -> stored` because the previous save's "Saved" was still on the page. And the Save that an act-while-pending sequence leaves in flight is now judged once the sequence settles, against the state from before the sequence and with the inputs as that Save sent them, so a page that says "Saved" over an HTTP 500 is reported as an invariant violation whose repro verify-fix and `regression capture` can replay.
