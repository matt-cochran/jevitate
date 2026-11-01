---
"@jevitate/explore": patch
---

Record a goal run's reload — the #303 persistence re-check after a write and the model's reload op — as the `reload` Step, not a `navigate` to the query-free pathname (#754). Replay now re-loads the live page (`page.reload()`), so a server-generated query value (e.g. `?id=<fresh>`) is never written into the Recording and the steps after the reload find the page the replay actually created.
