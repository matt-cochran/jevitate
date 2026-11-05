---
"@jevitate/cli": patch
"jevitate": patch
---

JSON output's `engine.version` now carries the same source-build marker as `--version` (`x.y.z-source-<commit>`), as do MCP's server version and SARIF's tool version, so a checker reading JSON can tell an unreleased source build from the published `x.y.z`. A release build reports plain `x.y.z`, as before. (#784)
