---
"@jevitate/cli": minor
"jevitate": minor
---

Catalog contract v4: a job's `guidance` (#874).
- **`guidance`** is a new optional job field with typed parts: `aliases` and `expectedStates` (navigation help, told to the model with `explore --job <id> --job-context`) and `claims` (statements to check, never told to the model). Every v3 file stays valid, and a job without `guidance` keeps its approval hash.
- **A verdict for every claim:** after a `--job-context` run the result's `claims[]` gives each claim `confirmed`, `contradicted` or `not_observed`, with its basis (`check`, `model`, `no-evidence` or `model-error`). A contradicted claim is a divergence to triage, noted on stderr, never a defect or an exit code.
- **Contract v4.0.0** is published under `packages/cli/contracts/jevitate-catalog/v4/`; v1 to v3 stay unchanged.
