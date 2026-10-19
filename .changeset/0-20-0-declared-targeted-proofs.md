---
"@jevitate/cli": minor
"jevitate": minor
---

`journey verify --mutate` accepts declared `metadata.targetedProofs` plans (#616): when an automatic targeted proof stops at its bound of 4, the report carries `suggestedTargetedProofs`, and a human-reviewed plan (at most 8 earlier `step:<n>` postconditions, each paired and itself proven sensitive to the mutation) runs one targeted replay plus one unmutated control. `journey readiness --mode prove` suggests the plan instead of asking to remove the checks, `journey review` lists each plan, and a proven target reads `declared plan relaxed …` with `declaredProof: true`.
Request checks count a request only when the capture saw it **sent** after the window began (identity, not a timestamp): a late response from an earlier attempt never satisfies a restarted step (#617).
