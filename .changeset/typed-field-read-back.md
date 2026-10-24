---
"@jevitate/cli": patch
"jevitate": patch
---

A field holding what the run itself typed on the current page load no longer counts as reading back a sent value (#671). Retyping a sent message into its composer after a reload let a send that stored nothing be reported as done.
