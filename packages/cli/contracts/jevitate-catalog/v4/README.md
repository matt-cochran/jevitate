# Jevitate repository catalog contract v4

This immutable contract release defines the git-backed `.jevitate/` files shared with consumers.
The JSON Schemas are closed where the runtime schemas are closed. The repository-catalog compatibility
exception for legacy persona descriptive keys remains: they participate in the persona approval hash.

## Changes from v3

- A job may carry `guidance` (#874): what a team knows about the job from outside Jevitate, typed so
  each part reaches a run the right way.
  - `aliases` (`{term, uiTerms[]}`) and `expectedStates` are navigation help, told to the model with
    `explore --job <id> --job-context`.
  - `claims` (`{id, statement, check?}`) are statements to check, never told to the model as fact.
    After such a run each claim gets a verdict (`confirmed`, `contradicted` or `not_observed`) and the
    basis that decided it: its own `check` (a done-check shape, read by code) when it has one, else a
    model judgment.
  - Nothing in `guidance` can set, satisfy or relax `--success` or the job's done check.

The field is optional and nothing else changed: the persona and Journey schemas, the file envelopes,
the approval-hash algorithm and vectors (`jevitate-content-hash-v2`) are those of v3. A job without
`guidance` has the same approval hash as before, so its approval stays valid.

## Compatibility

The v3 Job schema is closed, so a v3 validator refuses a `jobs.json` that uses `guidance`. A file valid
under v4 is therefore not always valid under v3, and v4 is published as contract major 4 rather than as
an in-place v3 revision. Every file valid under v3 is valid under v4, so a v4 reader may accept files
written for v3 unchanged; a consumer that pins v3 must move to v4 before it reads files that use
`guidance`. The repository catalog layout itself (file names, envelopes, the persona exception) is
unchanged, so `repositoryCatalogMajor` stays 1.

New approval hashes use `jevitate-content-hash-v2` and the vectors in `approval-hash-vectors.json`:
object keys sort lexicographically by unsigned UTF-16 code units; arrays retain order and the encoded
JSON has no insignificant whitespace. Readers may also recognize existing v1 approvals (JavaScript
`localeCompare`) during migration, but never write a new v1 approval. Session paths and login settings
are operational and excluded from persona approval hashes. A consumer must still run Jevitate's
semantic reference and approval checks; JSON Schema validation alone is insufficient. The immutable
v1.0.0, v2.0.0 and v3.0.0 contracts remain available at the sibling `v1/`, `v2/` and `v3/` paths.

The manifest records the source repository, the full source commit and the package version at that
commit. Publication is intentionally two commits: first commit source and generator changes, then
run the generator with that commit's SHA and commit the regenerated immutable contract.
