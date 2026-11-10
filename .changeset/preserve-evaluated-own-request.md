---
"@jevitate/cli": patch
---

Preserve an evaluated own-step request failure when the completed action also fails its DOM postcondition. A relaxed replay no longer erases that direct evidence. Missing or truncated capture, inapplicable blocks, and action or earlier failures remain unproven; changed evaluator semantics invalidate old proof receipts.
