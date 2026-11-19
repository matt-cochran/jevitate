# Jevitate run-result contract v1 (claim verdicts)

This immutable contract release defines the claim-verdict part of a run result, for external tools
that consume run results. It covers what a consumer needs to read the verdicts of a job's claims
after `jevitate explore --job <id> --job-context --json`.

## Where the fields are

The verdicts are in two places, with the same fields, built by one function:

- The JSON envelope the command prints on stdout, `{v, ok, data}`
  (`schemas/run-result.schema.json`). `v` is the envelope version (1); `ok` is `true` for a run that
  produced a result.
- The saved `<recording>.result.json`, `{missionOutcome, exitCode, result}`
  (`schemas/saved-result.schema.json`), whose path the envelope gives as `data.resultPath`. `result`
  holds the same fields as the envelope's `data`.

In both, the result (`data` or `result`) carries:

- `schemaVersion`, the result schema version (1), and `strategy`, which is `goal`.
- `jobContext`, `{job, contentHash}`: the catalog job id the run was told about and the content hash
  of the approved job it used, so a verdict is placed on that exact job version.
- `claims[]`, one verdict per `guidance.claims[]` entry of that job, in order
  (`schemas/claim.schema.json`): `id` and `statement` as the job states them, `verdict`
  (`confirmed`, `contradicted` or `not_observed`), `basis` (`check`, `model`, `no-evidence` or
  `model-error`) and, with `model-error`, a `reason`. `claims` is absent when the job has no claims.

A run without `--job-context` carries neither `jobContext` nor `claims`, and its saved result is
written once, unchanged. The result is open: every other field passes through and is outside this
contract. A claim and the job context are closed: a field this version does not name is refused. A
`contradicted` claim is a divergence between a document and the product for a person to triage; it
never changes the run's exit code. The result carries no run start time.

## Stability

A published contract never changes. An additive, optional field in a later release keeps this
contract valid for what it names; a change that a v1 validator would refuse, or that changes the
meaning of a named field, is a new contract major published beside this one at a sibling path.
Consumers vendor one exact released package and verify the manifest; they do not fetch a mutable
schema URL at runtime.

The manifest records the source repository, the full source commit and the package version at that
commit. Publication is intentionally two commits: first commit source and generator changes, then
run the generator with that commit's SHA and commit the regenerated immutable contract.
