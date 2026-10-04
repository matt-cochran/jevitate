---
"@jevitate/cli": patch
"jevitate": patch
---

`--reply-ceiling-ms` now bounds the total time a goal run waits for one sent message's reply — the send's own wait plus every `wait` step after it — instead of each wait cycle on its own. A chat whose reply never arrives no longer loops on "the reply is still on its way" for 10–20 minutes: once the ceiling is spent the run ends `no-progress` with `no reply within Ns to the last message sent ("…")`. A wait with nothing in flight and no page change now reads as no reply rather than a reply still on its way, while a reply that lands after several waits within the ceiling is still taken.
