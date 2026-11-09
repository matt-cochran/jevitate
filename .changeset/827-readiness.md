---
"@jevitate/cli": patch
"jevitate": patch
---

`journey readiness --mode replay|prove` takes a secret parameter from the environment (#827), as `journey verify` does: `--secret-field <binding>`, or the target's `targets.json` `secretFields` for its `--env` / `--base-url`. Over MCP, `journey_readiness` reads only `targets.json`; a request never names a variable. The value never appears in the receipt.
