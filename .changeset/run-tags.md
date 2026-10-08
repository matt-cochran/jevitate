---
"@jevitate/cli": minor
"jevitate": minor
---

Runs can now be tagged: `--tag key=value` (repeatable) on `explore`, `journey run`, `check`, `load run`, `verify-fix`, `regression run`, `demo`, `mission run`, `source run` and `campaign run` (and a `tags` object on the MCP run tools) stores the tags in `result.tags`, the `--json` envelope, a multi-run's `run.envelope.json` and the run index. `jevitate report --tag` and `jevitate diff --tag` filter runs by tag (every tag must match). Results also record a structured `target.startUrl`, `target.strategy` and, for persona runs, `target.persona`. Tags are plain metadata and never redacted, so never put a secret in one.
