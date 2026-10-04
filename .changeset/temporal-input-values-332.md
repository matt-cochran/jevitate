---
"@jevitate/cli": patch
"jevitate": patch
---

Typing into a date/time input no longer fails with Playwright's "Malformed value" (#332). A value for `<input type="time|date|datetime-local|month|week">` written the way people write it (`8:00 AM`, `10/3/2026`, `October 2026`) is typed in the input's wire format (`08:00`, `2026-10-03`, `2026-10`). A value that can't be read as one is rejected with the format the field takes, and the control's description shown to the model names that format (`format HH:MM`). A failed type or select now says which value it tried (registered secrets masked, credential fields redacted).
