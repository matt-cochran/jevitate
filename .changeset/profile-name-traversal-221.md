---
"@jevitate/cli": patch
"jevitate": patch
---

Security: a profile name or regression id can no longer escape its directory (#221). `profile create ../x` used to create a directory outside the profiles folder (profiles hold browser sessions). Profile names (`profile create|status`) and regression ids (`regression capture --id`, `regression run <id>`) must now be one safe path segment — 1–128 letters, digits, `.`, `_` or `-`, starting with a letter or digit, no `..`, `/`, `\`, NUL or absolute path — checked by one shared helper that also verifies the resolved path stays inside its root. A refusal is `E_INVALID_NAME`, exit 64.
