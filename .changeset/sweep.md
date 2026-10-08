---
"@jevitate/cli": minor
"jevitate": minor
---

New `jevitate sweep --targets <file.tsv|file.json>`: run many explore missions (one per feature or route, optionally per persona) with `--concurrency N`, resume an interrupted sweep with `--resume`, and stop early with `--stop-on-env-failure K` when the environment is broken. It writes one `sweep.result.json` with each target's outcome, depth and tags, defects deduped by fingerprint across targets (one finding with N sightings), and environment causes grouped. Every run is tagged `target=<id>`; the MCP tool is `run_sweep`. See docs/sweeps.md.
