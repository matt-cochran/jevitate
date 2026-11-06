---
"@jevitate/cli": minor
"jevitate": minor
---

**Behaviour change over MCP.** A value for a secret Journey parameter (declared `secret: true`, or named like a credential) is now refused with `E_SECRET_PARAM_OVER_MCP` before anything runs, on `run_journey`, `verify_journey`, `journey_readiness`, `chain_journeys`, `demo_journey`, `annotate_journey`, `run_load_test`, `run_exploration` and `sources`. These calls used to run with the value, which meant it had passed through the model. `${setup.x}` references are unchanged, and so are params that are not secret, with one exception: a name with a credential segment, such as `token_count` or `session_name`, is refused until its Journey declares `"secret": false`. `run_journey` with `env` or `baseUrl` now reads the value from the `secretFields` for that origin in `targets.json`, so a request can leave it out. A secret in a `navigate` URL has no field to bind, so it now runs on the CLI only.

`journey run` takes `--secret-field '<label|testId|id|name>=<value>=env:<VAR>'`, the binding a Journey is authored with, and `targets.json` `secretFields` apply to it with `--env` or `--base-url`, so a secret parameter stays off the command line. `--param` with a secret parameter keeps working on the CLI and now warns on stderr. See `docs/journeys.md`.

Which names count as credentials changed, everywhere that name check is used. It now matches a name's segments, not substrings: `pwd`, `authorization`, `auth`, `bearer`, `jwt`, `pin_code`, `privateKey`, `accessKey`, `mfa_code`, `ssn`, `cvv` and `sess` are now secret, so they are redacted and, over MCP, refused; `passengers`, `footprint`, `compass`, `bypass_cache`, `passport_country`, `spin` and `hotpink` no longer are. An explicit `"secret": false` on a declared parameter is now honoured.

A value `--secret-field` or `targets.json` supplies is only typed on its own origin (the entry's, or for the flag the run's allowlist): anywhere else, as after a redirect, the step fails with `E_SECRET_ORIGIN_REFUSED`. Two secret parameters on one binding, or two bindings on one parameter, now refuse before anything runs instead of typing a guessed value. A fixture output named like a credential is redacted and left out of `fixtures.outputs`, in `secretOutputs` or not. `verify-fix` and `regression` `--param` warn for a secret parameter.
