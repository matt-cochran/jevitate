---
"@jevitate/cli": patch
"jevitate": patch
---

`publish journeeze` reads the upload limit from `whoami` (`limits.maxUploadBytes`, default 95,000,000 bytes) and refuses an oversized bundle before sending it (#596).
