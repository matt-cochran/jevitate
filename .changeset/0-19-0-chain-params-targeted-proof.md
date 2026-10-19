---
"@jevitate/cli": minor
"jevitate": minor
---

`journey chain` takes producer params (`--param name=value`, MCP `params`), validated before anything runs (`E_CHAIN_PARAMS`); `journey readiness --with` passes them through the chain and refuses unknown params (`E_READINESS_PARAMS`) (#608).
`journey verify --mutate` proves an assertion that an earlier intentional defense masked, by relaxing those earlier step postconditions one at a time (bounded at 4), and reports `targeted`, `relaxedSites` and `targetedRefusal` (#609).
