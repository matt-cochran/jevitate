---
"@jevitate/cli": patch
"jevitate": patch
---

Paid controls with a live estimate (#280, #279). A goal asks for a `--paid` control by its action word: a trailing estimate ("Confirm analysis (≈ 4–10 credits)") and confirmation words ("Confirm", "and") are ignored, so "analyze this text" asks for "Confirm analysis"; the built-in label-length cap ignores the estimate too. The budget guard reads a numeric `dom` estimate at its worst case: a range such as "≈ 50–90 credits" counts as 90 (an explicit `number: { index }` is kept).
