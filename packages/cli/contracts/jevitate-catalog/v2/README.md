# Jevitate repository catalog contract v2

This immutable contract release defines the git-backed `.jevitate/` files shared with consumers.
The JSON Schemas are closed where the runtime schemas are closed. The repository-catalog compatibility
exception for legacy persona descriptive keys remains: they participate in the persona approval hash.

New approval hashes use `jevitate-content-hash-v2` and the vectors in
`approval-hash-vectors.json`: object keys sort lexicographically by unsigned UTF-16 code units;
arrays retain order and the encoded JSON has no insignificant whitespace. This writer is not readable
by consumers of the v1 contract, so it is published as contract major 2. Readers may also recognize
existing v1 approvals (JavaScript `localeCompare`) during migration, but never write a new v1
approval. Session paths and login settings are operational and excluded from persona approval hashes.
A consumer must still run Jevitate's semantic reference and approval checks; JSON Schema validation
alone is insufficient. The immutable v1.0.0 contract remains available at the sibling `v1/` path.

The manifest records the source repository, the full source commit and the package version at that
commit. Publication is intentionally two commits: first commit source and generator changes, then
run the generator with that commit's SHA and commit the regenerated immutable contract.
