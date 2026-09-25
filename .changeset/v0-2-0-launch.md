---
"@jevitate/cli": minor
"jevitate": minor
---

Jevitate v0.2.0: autonomous browser testing that turns discovered bugs into deterministic regression tests.

- **Reproduce, verify, lock in.** `verify-fix` replays a finding 3 times in fresh browser contexts and reports `intermittent` (exit 4) instead of a lucky `fixed`. `regression capture` now accepts failed success checks, network checks and declared-invariant violations as its oracle, never the engine's own refusals, and the new `regression run <id>` replays a committed regression.
- **App-declared invariants.** `--invariants` checks your own rules (DOM, network and read-only probes, including authenticated probes and cross-actor isolation checks) around every action. A violation is a defect.
- **CI gate and reporting.** `jevitate check --suite` runs Journeys, goals, missions, invariant sweeps and re-checks within a budget, writing JUnit and SARIF. `jevitate report`, `diff` and `baseline` give one deduped defect list and new / resolved / flaky classification.
- **Real apps.** Bound secrets typed by code, TOTP, `--save-storage-state`, mission fixtures around every run and replay (including `${secretField.X}` logins), authenticated queued missions via `targets.json`, backend log correlation (`--log-source`, `--log-defect`, `--log-ignore`, `--log-quiet-ok`; .NET and Serilog formats), `--repeat`/`--min-agreement` voting, persona matrices and multi-actor missions.
- **Safer by default.** Session-ending, destructive and paid controls are refused unless you pass `--allow-destructive`, find-out goals are read-only unless you pass `--allow-writes`, hang replays never re-send a paid write unless you pass `--hang-replay-writes`, every write request is listed, and gRPC-web/Connect reads are no longer treated as writes.
- **Honest outcomes.** Killed runs still write a result, unreachable targets and failed fixtures are `inconclusive` (configuration), stalled frontier runs end `stalled`, and every result carries the engine's version, commit and build time plus `usage` with the full run cost (Jev priced by default, `priced: partial` when any call is unpriced, and a per-call `usage.json`).
- **Better goal runs.** Network and persistence checks, visual-state checks, rich-text edits in `contenteditable`, grounded answers for find-out goals, and conversational-page handling.

Behaviour changes to check when upgrading from 0.1.0: coverage and exploratory runs are scoped to the start route by default (`--scope app` restores whole-app runs), the default safety policy refuses destructive and paid clicks, `textIncludes` is case-insensitive, `verify-fix` exits 4 for intermittent findings, find-out goals are read-only (`--allow-writes`), `--success-when held` needs a real change and stops once the checks hold, hang replays skip paid writes (`--hang-replay-writes`), a quiet log source under `--log-defect` makes a run `inconclusive` (`--log-quiet-ok`), an unknown invariant `when.op` is refused, `check` `maxUsd` fails closed on a partial cost, and `usage.usd` is superseded by `usage.totalUsd` (kept as a deprecated alias). See CHANGELOG.md for the full list.
