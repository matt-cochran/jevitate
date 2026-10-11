---
"@jevitate/cli": patch
"jevitate": patch
---

Internal refactor, no behaviour change (#499). The CLI's `explore` and `journey` command wiring, the MCP tool definitions and the Journey review sheet renderer are split from four large functions into an orchestrator plus per-command, per-domain and per-section modules. Commands, flags, output, MCP tools and exported APIs are unchanged; the `--help`, MCP parity, tool-allowlist and API-surface snapshots are byte-identical.
