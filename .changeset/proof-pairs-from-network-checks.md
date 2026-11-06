---
"@jevitate/cli": minor
"jevitate": minor
---

`journey verify --mutate` can now pair a Journey with no recorded delta from its own `responseStatus` checks. A check that names a write makes a write step of the one action step whose recorded page timing shows that request, so these Journeys get `skip` and `block-write` mutations where they had 0 pairs and read `inconclusive`. Their proofs now run real writes, and can reach `proven` or `insensitive`. A read RPC is not paired, nor is a request that several steps show or that a cut-short timing list could hide; a proof with no pairs then says why and what to add. An end-state network check that names one step's write is now paired with that step's mutations rather than the last write's, which can't break it.
