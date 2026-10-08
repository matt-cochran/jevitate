---
"@jevitate/cli": minor
"jevitate": minor
---

Open-ended find-out goals ("use the main features and report what works and every error") no longer stop after a page or two with "answer not found". `jevitate explore --min-actions <n> --min-distinct-states <n>` (also on `mission queue`, MCP `run_exploration`/`queue_exploration`, and suite goals) sets the minimum exploration before the model may conclude, and an open-ended find-out gets a budget-scaled default; an early report or give-up is deferred and the run is steered to unvisited tabs, detail views and forms. Every goal result now records its `depth` (distinct states and pages, actions, forms submitted, the minimum and whether it was met), and a find-out that still cannot ground an answer returns a grounded `partialReport` — per page, its own text, its controls and what was tried — printed as `PARTIAL` lines.
