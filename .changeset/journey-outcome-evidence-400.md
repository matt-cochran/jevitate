---
"@jevitate/cli": minor
"jevitate": minor
---

`explore-author-journey` keeps the outcome evidence in the Journey (#400). Every `--success` check, of any kind (`textIncludes`, `valueEquals`, `count`, `attr`, `flashed`, `requestMade`, `responseStatus`, and now `reloadThen`), is saved as the Journey's end state (`metadata.endState`), and `journey run` / `source run` judge it after the last step with the goal run's own evaluator (one reload for the `reloadThen` checks). A step's `expect` now comes from what it changed: a write it sent becomes `expectRequests: responseStatus:<METHOD> <path>=2xx`, judged over the requests sent from that step on; a fill asserts its value; with `--action-deltas`, a step that changed the page asserts the text or element it added. Authoring never writes "the clicked target is visible" again. Older Journeys load and run unchanged.
