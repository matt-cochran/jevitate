---
"@jevitate/cli": patch
"jevitate": patch
---

MCP `run_journey` and `queue_journey` take `noDoneCheck` and `requireDoneCheck`, the parity of `journey run --no-done-check` and `--require-done-check` (#800); not both. `jevitate journey queue` takes the two flags too. A queued call stores them, and `mission run` drains it with them.
