---
"@jevitate/cli": patch
"jevitate": patch
---

Bind production release verification to the release-candidate artifact that was available when staging published it, preventing a later same-tree rebuild from blocking an otherwise byte-verified promotion.
