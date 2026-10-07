---
"@jevitate/cli": minor
"jevitate": minor
---

`jevitate journey verify <id> --mutate` proves each of a Journey's assertions can fail. It replays
the Journey once as recorded (it must pass), then once per mutation — each write step skipped
(`skip:<n>`), its write requests aborted (`block-write:<n>`), and each fill whose value an assertion
checks typed empty (`stale-value:<n>`) — and reports every assertion as `sensitive` (its paired
mutation broke it, at that assertion), `insensitive` (vacuous: it still passed), `cascade`,
`not-applied` or `unpaired`, with the Journey's content hash. Exit `0` when every paired assertion
is sensitive, `1` when any is insensitive, `2` when the proof is inconclusive. Mutations only skip
a step, type an empty value or abort the app's own writes; they never send or answer a request.

A Journey can pin pairings in `metadata.mutationPairs` (`{ check: "end-state:0", mustFailWhen:
"skip:publish" }`, anchors by name), validated when it loads.
