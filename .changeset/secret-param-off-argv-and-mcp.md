---
"@jevitate/cli": minor
"jevitate": minor
---

**Behaviour change over MCP.** A value for a secret Journey parameter (declared `secret: true`, or named like a credential) is now refused with `E_SECRET_PARAM_OVER_MCP` before anything runs, on `run_journey`, `verify_journey`, `journey_readiness`, `chain_journeys`, `demo_journey`, `annotate_journey`, `run_load_test`, `run_exploration` and `sources`. These calls used to run with the value, which meant it had passed through the model. Non-secret params and `${setup.x}` references are unchanged. `run_journey` with `env` or `baseUrl` now reads the value from the `secretFields` for that origin in `targets.json`, so a request can leave it out. A secret in a `navigate` URL has no field to bind, so it now runs on the CLI only.

`journey run` takes `--secret-field '<label|testId|id|name>=<value>=env:<VAR>'`, the binding a Journey is authored with, and `targets.json` `secretFields` apply to it with `--env` or `--base-url`, so a secret parameter stays off the command line. `--param` with a secret parameter keeps working on the CLI and now warns on stderr. See `docs/journeys.md`.
