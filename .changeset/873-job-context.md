---
"@jevitate/cli": minor
"jevitate": minor
---

`explore --job <id> --job-context` tells the model about the job (#873).
- **Opt-in mission brief:** the job's approved story, `context` and `constraints` from `.jevitate/jobs.json` are given to the model with the goal. `--job` alone is unchanged.
- **Mistake-proofed:** a draft or stale job is refused before any run (`E_EXPLORE_JOB`), a brief over 2000 characters is refused rather than truncated, and `--job-context` without `--job` is a usage error. The brief never satisfies `--success` or the done check.
- **Recorded:** the result carries `jobContext: {job, contentHash}`.
