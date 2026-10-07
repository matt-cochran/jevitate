---
"@jevitate/cli": patch
"jevitate": patch
---

Adversarial runs no longer send misuse values to an origin outside `--allow` (#403). A write request (a fetch/XHR or a native form post) that a misuse step fires to another origin is now aborted in the browser, listed in the result's `blockedWrites` with that origin and how to allow it (`--allow` the origin, or `--allow-write "<origin>/<path glob>"`), and never reported as a defect of the app; reads and subresources from other origins load as before. `docs/safety.md` now states exactly what `--allow` guarantees (the acting origin, checked before launch and after each settle; find-out goal writes; adversarial misuse writes) and what it does not block (subresources and third-party reads).
