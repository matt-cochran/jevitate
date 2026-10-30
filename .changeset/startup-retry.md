---
"@jevitate/cli": patch
"jevitate": patch
---

Retry the first navigation a short, bounded number of times before any action or write (#742). A target that refuses the first navigation while its origin answers a plain HTTP probe is no longer finalized `target-unreachable`: the bounded retry records what each try did in the run result's `attempts[]`, runs its backoff on the injected clock, stays within a 60 s worst-case budget, and never retries a guard-blocked departure.
