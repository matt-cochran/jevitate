---
"@jevitate/cli": minor
---

`journey run` waits for a step's in-flight request instead of quarantining on it (#486): a
`responseStatus` check whose request was sent but has no response yet (a cold start after a deploy)
waits up to `--step-response-timeout <ms>` (default 15000; a step's own `responseTimeoutMs`
overrides it). A 2xx that arrives in time passes and is reported as an advisory `slowSteps` finding
with its measured latency; a non-2xx, or no response within the bound, still fails. `jevitate check`
and `campaign run` report a step slow on a Journey's first replay and fast on later ones as a
`cold-start` note (`slowness.coldStarts`), advisory and never changing an exit code.
