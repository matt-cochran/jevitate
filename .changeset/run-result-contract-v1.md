---
"@jevitate/cli": patch
"jevitate": patch
---

Publish the run-result contract v1 for claim verdicts. The CLI package now ships
`contracts/jevitate-run-result/v1/`: JSON Schemas for the claim-verdict part of an
`explore --job <id> --job-context --json` result (the `{v, ok, data}` envelope with
`data.jobContext` and `data.claims[]`), conformance fixtures and a SHA-256 manifest, generated
from the runtime schema, for external tools that consume run results.
