---
"@jevitate/cli": patch
"jevitate": patch
---

A failed control's `controlDiagnostics` no longer has `indicates`, the inferred label for why it failed, which was never checked against a real failure. The counts it was read from stay.
