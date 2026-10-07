---
"@jevitate/cli": patch
"jevitate": patch
---

Journeys authored with `--action-deltas` now say what each step is expected to change (#400): a step with a recorded delta gets its `expectedResult` filled by code from that delta, so the reviewer sees what each step is supposed to prove. An `expectedResult` already present is never overwritten, and steps without a delta are unchanged.
