---
"@jevitate/cli": patch
"jevitate": patch
---

`journey run` (and verify, prefix, campaign, load and `source run`) accepts a declared parameter that only an assertion names, requires it when missing and still refuses an undeclared one (#573).
