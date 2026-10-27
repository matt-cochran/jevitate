---
"@jevitate/cli": minor
---

Add repeatable descriptor-bound `--upload-fixture` bindings for deterministic multi-file Journey authoring. Matching file inputs receive only their declared, project-confined file after the model selects upload; CLI and MCP preserve filename-only model context, reject duplicate/ambiguous bindings, and retain `--fixture` as the backward-compatible fallback.
