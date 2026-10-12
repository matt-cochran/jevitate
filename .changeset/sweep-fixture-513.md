---
"@jevitate/cli": minor
"jevitate": minor
---

`sweep` targets can carry their own upload fixture (#513). A target's `options.fixture` (JSON, `defaults.options` or a TSV column) and a sweep-wide `sweep --fixture <file>` are forwarded to each run; a target's own fixture wins. Both are confined like every upload fixture (#498: inside the project root, sensitive files refused), checked when the sweep spec loads, so a bad path fails the whole sweep up front (`E_SWEEP_SPEC` / `E_SWEEP_ARGS`). MCP `run_sweep` takes `fixture`.
