---
"@jevitate/cli": patch
"jevitate": patch
---

Done checks, made to match the 0.30.0 decisions. A goal run on a target declared `trust: "harness"` (`explore --job`, `run_exploration`, a queued exploration) now reads `job: { attainment: "unverified", basis: "harness" }` and exits 0 on a pass, as `journey run` does; it could read `achieved` (#802). A find-out goal whose grounded answer was accepted keeps exit 0 under `doneCheckPolicy: "require"`, since it claims no end state; `--require-done-check` still makes it exit 2. `explore --job` with a job id the catalog does not have (`E_EXPLORE_JOB`) now exits 64, a usage error, where it exited 2. A Journey that links no job may carry its own done check in `metadata.done`, in the jobs.json shape: `journey run` reads it, `journey lint` checks it by the same rules (and refuses it beside a linked job, whose check always wins), and the review sheet shows it.
