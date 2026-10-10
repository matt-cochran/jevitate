---
"@jevitate/cli": patch
---

Anchor names now match the catalog bundle v1 `anchorName`: 1-64 of lowercase a-z, 0-9, . _ -
starting with a letter or digit. `journey lint`/promote no longer silently drop names the export
refuses (#478).
