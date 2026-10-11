---
"@jevitate/cli": minor
---

MCP parity for the 0.11 CLI capabilities:

- New MCP tools `journey_anchor_add` / `journey_anchor_remove` (`journey anchor add|remove`, #487): edit a draft Journey's anchors with the step id written at once; a promoted Journey is refused, as on the CLI.
- `lint_journey` takes `fix` (`journey lint --fix`, #487) and `journey_anchors` takes `suggest` (`journey anchors --suggest`, advisory, writes nothing).
- `run_journey` takes `stepResponseTimeoutMs` (`journey run --step-response-timeout`, #486).
- `verify_fix` takes `allow` or `env` (`verify-fix --allow/--env`, #484): explicit only, never both; the result carries `allowlistOverride`.
- `run_campaign` takes `skipPreflight` (`campaign run --skip-preflight`, #485), recorded on the report as `preflight.skipped`.
- An adversarial run's transcript now reads a finding a blocked write caused as an environment fault instead of `defect:` (#484).
