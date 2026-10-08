---
"@jevitate/cli": minor
"jevitate": minor
---

Judgment (the Jev model) now runs on either a TypeSafe key or an OpenRouter key. OpenRouter serves Jev at its System One route as `~typesafe/jev-latest`, so one OpenRouter key can cover both generation and judgment. When both keys are set, the TypeSafe key wins. To choose explicitly, use `--jev-provider typesafe|openrouter` (MCP `jevProvider`) or `JEVITATE_JEV_PROVIDER`. `ai status` shows which key, route and model judgment will use, and `ai setup judgment --jev-provider openrouter` sets up the OpenRouter key.
