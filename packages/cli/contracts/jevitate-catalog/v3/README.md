# Jevitate repository catalog contract v3

This immutable contract release defines the git-backed `.jevitate/` files shared with consumers.
The JSON Schemas are closed where the runtime schemas are closed. The repository-catalog compatibility
exception for legacy persona descriptive keys remains: they participate in the persona approval hash.

## Changes from v2

- A job may carry `done`, its done check (`{version: 1, at, check, session?, distinguishedBy?}`): a
  statement about the application's state, read at the path `at`, that is false before the job is
  done and true after.
- A Journey param may carry a `type` (`string`, `number`, `boolean`, `enum`, `email`, `url`, `date`)
  and, for `enum`, the allowed values in `enum`.

Both fields are optional and nothing else changed: the persona schema, the file envelopes, the
approval-hash algorithm and vectors (`jevitate-content-hash-v2`) are those of v2.

## Compatibility

The v2 Job and Journey schemas are closed, so a v2 validator refuses a file that uses `done` or a typed
param. A file valid under v3 is therefore not always valid under v2, and v3 is published as contract
major 3 rather than as an in-place v2 revision. Every file valid under v2 is valid under v3, so a v3
reader may accept files written for v2 (for example a `jobs.json` without `done`) unchanged; a
consumer that pins v2 must move to v3 before it reads files that use the new fields. The repository
catalog layout itself (file names, envelopes, the persona exception) is unchanged, so
`repositoryCatalogMajor` stays 1.

New approval hashes use `jevitate-content-hash-v2` and the vectors in `approval-hash-vectors.json`:
object keys sort lexicographically by unsigned UTF-16 code units; arrays retain order and the encoded
JSON has no insignificant whitespace. Readers may also recognize existing v1 approvals (JavaScript
`localeCompare`) during migration, but never write a new v1 approval. Session paths and login settings
are operational and excluded from persona approval hashes. A consumer must still run Jevitate's
semantic reference and approval checks; JSON Schema validation alone is insufficient. The immutable
v1.0.0 and v2.0.0 contracts remain available at the sibling `v1/` and `v2/` paths.

The manifest records the source repository, the full source commit and the package version at that
commit. Publication is intentionally two commits: first commit source and generator changes, then
run the generator with that commit's SHA and commit the regenerated immutable contract.
