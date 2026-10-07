---
"@jevitate/cli": patch
"jevitate": patch
---

An icon-only control named by its `title`, `aria-labelledby` or a nested image's `alt` now shows that name in the control list, so `--deny` and `--paid` patterns match it (#396). A control that still has no accessible name is never clicked when the run declares `--deny` or `--paid` patterns, since those patterns can't be checked against it.
