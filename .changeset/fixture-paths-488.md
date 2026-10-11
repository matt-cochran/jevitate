---
"@jevitate/cli": patch
---

A Journey's relative upload fixture path now resolves against the project root (the folder holding `.jevitate/`), not the process working directory, so `journey run` works from any directory or CI working dir. `journey lint` reports a missing upload fixture as `upload-file-missing` (error) with the resolved path (#488).
