---
"@jevitate/cli": minor
"jevitate": minor
---

**Exit code change.** A goal run that covers every control it can reach, with none leading toward the goal, now ends `inconclusive` (exit 2) with `goalReason: "no-route-found"` and `failure.kind: "no-route-found"`. It ended `blocked` or `exhausted`, exit 1. Its reason lists the pages it opened. Code decides the coverage floor: every top-level navigation page opened, no untried control left on a page it saw, no control naming the goal, and nothing clickable the run cannot use (an `onclick` element outside a control, a canvas, a frame). Below the floor the run ends as before. A role word on the page ("Viewer", "Read-only", "Guest") is named as a hint that another role may see more, never as a wall (#807).

**Exit code change.** A goal run that passes while its job's final done-check reading is false (`--job`, `job.attainment: "not-achieved"`) now exits 1 `defects-found` with `failure.kind: "done-check-failed"`. It exited 0. This holds under either `doneCheckPolicy` and whatever verified the pass: the find-out exemption covers only a job that nothing verified.
