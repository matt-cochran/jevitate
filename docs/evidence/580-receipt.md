# #580 acceptance receipt

The two-Journey Bizops comment workflow, on the offline fictional fixture. Everything below was run
on 2026-10-18; nothing touched a real account, a real comment or production.

## Engine

- Delivered in 0.17.0 (`journey chain`, typed handoffs follow in 0.18.0) and completed in 0.18.1
  (`--project` catalog fix, readiness and bundle reflecting authorization).
- The published 0.17.0 and 0.18.0 packages were each installed from npm `next` and dogfooded on this
  fixture before promotion to `latest`.

## Artifacts

| Artifact | sha256 (prefix) | Review hash (prefix) |
| --- | --- | --- |
| `test/fixtures/bizops-community/.jevitate/journeys/discover-conversations.json` | `46bff525651b2cc1` | `f127a92cd40bdd72` |
| `test/fixtures/bizops-community/.jevitate/journeys/prepare-reply.json` | `e427ed8cff4a0b1d` | `b7428bb6f70a98fe` |
| `test/fixtures/bizops-community/.jevitate/personas.json` | `441d55f6d0015b6f` | — |
| `test/fixtures/bizops-community/.jevitate/jobs.json` | `df9fca66f76ad4ff` | — |
| `test/fixtures/bizops-community/server.ts` | `17e3b87a662e263a` | — |

## Checks run and results

| Acceptance | Evidence | Result |
| --- | --- | --- |
| 1. Fixture + repeatable command running both Journeys with returned outputs (2 identities, 2 threads, different text) | `bizops-workflow-served.test.ts`, `journey chain` | pass: 8 records discovered; matched requests prepared; 0 submissions |
| 2. Fail-closed: changed comment / parent / thread / account / context, missing input, wrong valid dropdown, altered text | `bizops-workflow-served.test.ts` (6 wrong-value cases + missing input + unmatched) | pass: each refused before the composer is written; missing input refused before a browser opens; 0 submissions |
| 3. Conclusive mutation proof for selection and exact-text checks | `bizops-proof-served.test.ts`, [580-mutation-proof.md](580-mutation-proof.md) | prepare-reply **proven** 9/9 sensitive, 0 cascade, 0 timeout, on records from both posts. discover: nothing to mutate (read-only, no inputs), which readiness reports as such |
| 4. Job/persona links, step objectives, strict review clean after the human catalog review | `journey review --strict` | pass: 0 warnings on both Journeys after the sign-off below |
| 5. Stable request/output schemas; the same workflow over CLI and MCP; no selector/eval escape hatch | [journey-chain-contract.md](../journey-chain-contract.md), [contracts/journey-handoff.md](../contracts/journey-handoff.md); MCP `chain_journeys`, `journey_readiness`, `journey_bundle` | pass |
| 6. This receipt | — | — |

`jevitate journey readiness discover-conversations --with prepare-reply` (report mode) gives
**technically-ready**, with no blockers and nothing awaiting a person.

## Human sign-off

Done by a person at a terminal (provenance `tty`), each bound to the hash of the sheet that person
read:

- `persona approve bizops-operator`: `2ff8b19b…`
- `job approve answer-community-comments`: `854c1c17…`
- `journey promote discover-conversations`: `f127a92c…`
- `journey promote prepare-reply`: `b7428bb6…`

No waiver, accepted finding or auto-promotion was used.

## Remaining human-only steps

None for this fixture. Outside its scope, as the ticket requires:
- real provider comment selectors and ids are validated separately once real comments and production
  automation are authorized;
- browser execution in deployed Bizops stays disabled;
- replies are still posted by a person.
