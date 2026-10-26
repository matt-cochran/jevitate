---
"@jevitate/cli": patch
---

Preserve a completed step's request-check evidence when a later action fails during mutation verification, so an exact earlier failure is not misreported as a cascade.
