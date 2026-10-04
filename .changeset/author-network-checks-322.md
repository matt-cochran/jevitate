---
"@jevitate/cli": minor
"jevitate": minor
---

`explore-author-journey` accepts every success check `explore` accepts except `reloadThen` (#322). `--success` is now repeatable (all checks must hold) and takes `requestMade:` and `responseStatus:` checks, so a job whose only honest success signal is a request can be saved as a Journey. A page check becomes the Journey's last `assert` step, as before. A network check is stored in the Journey as `metadata.networkChecks`, and `journey run` (and `source run`) evaluates it over the requests the replay itself sent: a replay whose steps all pass but whose expected request never went out, or got the wrong status, fails with the check named. `reloadThen` is refused with a clear message. Upgrade note: the MCP `author_journey` tool's `success` argument is now an array of strings.
