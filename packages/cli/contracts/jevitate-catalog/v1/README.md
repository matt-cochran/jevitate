# Jevitate repository catalog contract v1

This immutable contract release defines the git-backed `.jevitate/` files shared with consumers.
The JSON Schemas are closed where the runtime schemas are closed. The sole v1 exception is legacy
persona descriptive keys: they remain open and participate in the persona approval hash; a future
v2 moves non-core data under the namespaced `extensions` object.

Approval hashes use `approval-hash-vectors.json`. Session paths and login settings are operational
and excluded from persona approval hashes. A consumer must still run the semantic reference and
approval checks documented by Jevitate; JSON Schema validation alone is insufficient.
