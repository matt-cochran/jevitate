---
"@jevitate/cli": patch
"jevitate": patch
---

Publish the run-result contract v1 for claim verdicts. The CLI package now ships
`contracts/jevitate-run-result/v1/`: JSON Schemas for the claim-verdict part of an
`explore --job <id> --job-context` result (`jobContext` and `claims[]`, in the `--json` envelope's
`data` and in the saved `<recording>.result.json`'s `result`), conformance fixtures and a SHA-256
manifest, generated from the runtime schema, for external tools that consume run results. The saved
result of such a run now carries the claim verdicts too, so MCP `get_mission_result` returns them.
