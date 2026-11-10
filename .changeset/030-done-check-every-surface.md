---
"@jevitate/cli": patch
"jevitate": patch
---

Every surface that replays a Journey and reports its pass now reads the job's done check and folds it into the exit, as `journey run` and `run_journey` do: `journey chain` / `chain_journeys` (the producer and each consumer; `job` on `from` and on each run), `inbox resume` (the resumed run, or the whole chain), and `source run`. A job not achieved exits 1 (`failure.kind: "done-check-failed"`); an unverified pass exits 2 under the default `doneCheckPolicy: "require"`. Before, these surfaces exited 0 on a pass whatever the job. A self-heal run's `*.result.json` now keeps `job` and the folded exit code. A hold made by a chain's producer also binds the consumer Journey's content hash and the requests file's sha256; `inbox resume` refuses (`E_HOLD_BINDING`, `consumer` or `requests`) when either changed since.
