# Jevitate repository catalog contract v1

This immutable contract release defines the git-backed `.jevitate/` files shared with consumers.
The JSON Schemas are closed where the runtime schemas are closed. The sole v1 exception is legacy
persona descriptive keys: they remain open and participate in the persona approval hash; a future
v2 moves non-core data under the namespaced `extensions` object.

New approval hashes use `jevitate-content-hash-v2` and the vectors in
`approval-hash-vectors.json`: object keys sort lexicographically by unsigned UTF-16 code units;
arrays retain order and the encoded JSON has no insignificant whitespace. Readers also recognize
existing v1 approvals (JavaScript `localeCompare`) but never write a new v1 approval. Session paths
and login settings are operational and excluded from persona approval hashes. A consumer must still
run Jevitate's semantic reference and approval checks; JSON Schema validation alone is insufficient.

The manifest records the source repository, the full source commit and the package version at that
commit. Publication is intentionally two commits: first commit source and generator changes, then
run the generator with that commit's SHA and commit the regenerated immutable contract.
