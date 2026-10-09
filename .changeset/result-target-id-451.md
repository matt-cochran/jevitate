---
"@jevitate/cli": minor
"jevitate": minor
---

Results carry the target they were meant to cover (#451): `explore --target <id>` (set automatically per target by `jevitate sweep`) is stamped as `target.id` in the result, its envelope and the run index. Key attribution on `target.id`, not on the start URL.
