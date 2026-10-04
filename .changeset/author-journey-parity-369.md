---
"@jevitate/cli": minor
"jevitate": minor
---

`explore-author-journey` now runs every take as the same goal run as `explore --strategy goal`, and accepts its run-shaping flags: `--secret`, `--secret-field` (including `cmd:` sources with `--allow-secret-cmd` and `--secret-cmd-attempts`), `--totp`, `--type-fixture`, `--fixture`, `--success-when`, `--allow-vacuous-checks`, `--action-deltas`, `--dialogs`, `--deny`/`--paid`/`--allow-destructive`, the reply and job waits, `--viewport`/`--device`/`--geolocation`, `--screenshots`, `--save-storage-state` and `--out` (MCP `author_journey` takes the same arguments, except the operator-only secret sources). A field typed from a secret binding becomes a secret Journey parameter instead of failing the authoring. A `not-reached` result now says why and where to look: the discovery run's stop reason, check verdicts, result, transcript, Recording and screenshots paths, and the take count, in the JSON and the human summary. A `reloadThen:` check is still refused before any browser opens, now with the inner check to author instead.
