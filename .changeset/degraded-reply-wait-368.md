---
"@jevitate/cli": patch
"jevitate": patch
---

A configured chat reply wait (`--reply-wait-ms` / `--reply-ceiling-ms`), a job wait (`--job-wait-ms`) or a `wait` step no longer counts as page render time, so a reply that never arrives can no longer end a run `inconclusive` as "starved: renders 30079ms vs the run's baseline" on a healthy host. A slow render now counts as host starvation only when host samples corroborate it (load of at least one runnable task per core); on a healthy host it stays the app's own timing. A goal run that ends still waiting on a reply now says so: `no reply within 30s to the last message sent ("…")`.
