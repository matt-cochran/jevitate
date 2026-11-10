---
"@jevitate/cli": patch
"jevitate": patch
---

A mutation-proof receipt now records the target origin it ran on and, when known, the app version (`journey verify --app-version`, MCP `verify_journey` `appVersion`, or `JEVITATE_APP_VERSION`). A receipt from another target origin or app version reads stale, with `staleCause: "target"` or `"app-version"`. A receipt that names no target, or no app version while one is set now, still shows (a ○ note under `advisory`) and never counts for `require-sensitive`. Under `mutationProofPolicy: "require-sensitive"`, `journey verify` now exits 2 for a `sensitive` proof with `countsForGate: false`; under `advisory` it still exits 0. `journey review --env <name>` / `--base-url <url>` (MCP `review_journey` `env` / `baseUrl`) judges a proof's freshness for that target, resolved as `journey verify` resolves it, so a proof made on `--env staging` reviews fresh with `--env staging`; with neither, review judges the Journey's recorded site, as before.
