# Jevitate run-result contract v1 (claim verdicts)

This immutable contract release defines the claim-verdict part of a run result, for external tools
that consume run results. It covers what a consumer needs to read the verdicts of a job's claims
after `jevitate explore --job <id> --job-context --json`.

## Where the fields are

The command prints one JSON envelope on stdout, `{v, ok, data}`, described by
`schemas/run-result.schema.json`:

- `v` is the envelope version (1); `ok` is `true` for a run that produced a result.
- `data.schemaVersion` is the result schema version (1) and `data.strategy` is `goal`.
- `data.jobContext` is `{job, contentHash}`: the catalog job id the run was told about and the
  content hash of the approved job it used, so a verdict is placed on that exact job version.
- `data.claims[]` holds one verdict per `guidance.claims[]` entry of that job, in order
  (`schemas/claim.schema.json`): `id` and `statement` as the job states them, `verdict`
  (`confirmed`, `contradicted` or `not_observed`), `basis` (`check`, `model`, `no-evidence` or
  `model-error`) and, with `model-error`, a `reason`. `claims` is absent when the job has no claims.

`data` is open: every other field of the result passes through and is outside this contract. A claim
and the job context are closed: a field this version does not name is refused. A `contradicted`
claim is a divergence between a document and the product for a person to triage; it never changes
the run's exit code. The result carries no run start time.

The claim verdicts are in the emitted envelope only. The persisted `<recording>.result.json` is
written before the claims are evaluated and does not hold `jobContext` or `claims`.

## Stability

A published contract never changes. An additive, optional field in a later release keeps this
contract valid for what it names; a change that a v1 validator would refuse, or that changes the
meaning of a named field, is a new contract major published beside this one at a sibling path.
Consumers vendor one exact released package and verify the manifest; they do not fetch a mutable
schema URL at runtime.

The manifest records the source repository, the full source commit and the package version at that
commit. Publication is intentionally two commits: first commit source and generator changes, then
run the generator with that commit's SHA and commit the regenerated immutable contract.
