---
"@jevitate/cli": patch
"jevitate": patch
---

Short credentials no longer mangle ordinary text (#454). A secret shorter than 6 characters (a short username such as `me`) is redacted, and blocked from model payloads, only where it stands as a whole token, not inside words, so "Timeout" stays "Timeout". Longer secrets are still matched anywhere, in every encoded form, and the payload guard stays fail-closed (it also checks each decoded string of a structured payload).
