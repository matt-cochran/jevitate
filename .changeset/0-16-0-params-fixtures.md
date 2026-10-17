---
"@jevitate/cli": minor
"jevitate": minor
---

Reusable, parameterized Journeys: assertions can refer to parameters and extracted values (`{ "var": "name" }` or `${name}`) and `verify --mutate` proves them (#562, #565); fixture restore steps can look up what a Journey created (#560); environments map named secondary origins such as an API (#561); check suites generate per-run unique param values (#563); `jevitate record` writes a take file that `recording diff`/`postdoc` accept (#564), and `recording propose` drafts parameters, outputs and checks from two or more takes (#566). Relaxed mutation replays stay schema-valid (#567).
