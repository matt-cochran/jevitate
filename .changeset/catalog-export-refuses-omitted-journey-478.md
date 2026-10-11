---
"@jevitate/cli": patch
---

`catalog export` (and `publish journeeze`) now refuses with exit 64 when a promoted Journey cannot be carried by the bundle, instead of leaving it out with only a warning (#478).
