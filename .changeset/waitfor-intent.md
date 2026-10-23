---
"@jevitate/cli": patch
"jevitate": patch
---

A `waitFor` step's documented `expectedResult` no longer draws an `intent-uncovered` warning: the wait's target and state are enforced when the step runs, so they count as its checked outcome in `journey lint`, strict review and linked readiness (#659). Steps whose effect really is unchecked still warn.
