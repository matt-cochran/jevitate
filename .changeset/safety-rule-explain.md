---
"@jevitate/cli": minor
"jevitate": minor
---

Every safety refusal now names the rule it matched — e.g. `[rule builtin:may-cost-money, matched "Generate"]`, `deny:<pattern>`, `paid:<pattern>` or `read-only:<kind>` — and the transcript entry carries it as `safety: { ruleId, pattern, control }`. New `--allow-control <regex>` (explore, explore-author-journey, campaign run, suite items, MCP, and `safety.allowControl` in targets.json) exempts one benign control from the soft "may cost money" heuristic only; it never lifts `--deny`, `--paid`, destructive, session-end, read-only or origin rules, and every use is recorded in the result's `safetyOverrides`. `jevitate site policy rules` lists every rule, what it matches and whether `--allow-control` can waive it.
