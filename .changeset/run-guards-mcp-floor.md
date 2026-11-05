---
"@jevitate/cli": minor
"jevitate": minor
---

Behaviour change: over MCP, a Journey now has to be promoted and its approval current to run. `run_journey`, `chain_journeys` and `run_load_test` refuse an unpromoted Journey (`E_JOURNEY_NOT_PROMOTED`), one changed since its approval (`E_JOURNEY_APPROVAL_STALE`) or one whose approval can't be read (`E_JOURNEY_APPROVAL_UNKNOWN`), before any browser, naming the command that fixes it. `journey run` still runs them and warns once on stderr. `load run` now refuses an unpromoted Journey, as its help always said. Over MCP, `run_check` and Journey-anchored missions also refuse a stale approval. (#788)

Behaviour change: an MCP-driven replay no longer clicks session-ending, destructive or paid controls, nor presses Enter in a field whose form's default button is one, and no longer lets a write leave the browser for an origin outside the run's allowlist, and doesn't replay on an environment flagged `production: true`. It ends with a typed refusal (`E_RUN_REFUSED_DESTRUCTIVE`, `E_RUN_REFUSED_OFF_ALLOWLIST_WRITE`, `E_RUN_REFUSED_PRODUCTION`) that names the setting. Only a person lifts these, per target, in `~/.jevitate/targets.json`: `mcpRun.allowDestructive`, `mcpRun.allowOffAllowlistWrites` (origins) and `mcpRun.allowProduction`. An app whose pages post to third-party telemetry needs those origins listed. `journey run` is unchanged. (#789)

Every `run_journey` and `journey run` now leaves one value-free record under `.jevitate/logs/<date>/journey-run-*.json`: Journey id and hash, origin, outcome, step count, writes by method and path shape, timestamps and channel. A record that can't be written never changes the run's outcome; it is reported as `runRecordError`. `logs prune` covers these records and now also the proof receipts in `logs/verify-progress/`. (#790)
