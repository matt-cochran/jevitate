---
"@jevitate/cli": patch
"jevitate": patch
---

`journey review/promote/lint/migrate`, `journey readiness` and `journey bundle` read the catalog of `--project` (they read the working directory's project's catalog) (#585).
`journey readiness` passes the proof of a read-only Journey that takes no input (nothing a mutation could break) (#581).
`journey bundle` lists only the approvals and promotions still pending, each once (#584).
