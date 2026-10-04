---
"@jevitate/cli": minor
"jevitate": minor
---

New `--success-when each` for goals whose success checks live on different pages (#337), for example "Connected" on Connections and then "Payments ready" on Pricing. No single page holds both, so `final` fails on whichever page is last and `held` (all checks holding together at one step) can never pass. Under `each`, every page check counts once it went from not holding to holding at some settled step, each at its own step and in any order. The run stops as soon as all have held, before the model wanders on. A check that held on the start page and never changed is vacuous, as under `held`. `each` is also available as `successWhen` in suite items and as the MCP `run_exploration` argument.
