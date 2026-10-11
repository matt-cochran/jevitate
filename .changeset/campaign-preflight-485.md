---
"@jevitate/cli": minor
---

`campaign run` now checks its own preconditions before any mission and refuses (exit 64, `E_CAMPAIGN_PREFLIGHT`) listing every problem: an unreachable start URL, a job's `storageState` that is no longer signed in, and a discovery replay that wrote to a loopback origin the environment's `allow` list misspells or leaves out (`localhost` vs `127.0.0.1`) — naming the exact origin to add. The verdict is `preflight: { ok, problems }` in `campaign.json` and the human summary; `--skip-preflight` runs without it. `journey run` results list `offAllowlistWrites` (origins only) when the replay wrote outside its allow list (#485).
