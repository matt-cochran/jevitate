---
"@jevitate/cli": minor
"jevitate": minor
---

`journey chain` fails closed on rejected records and requests (#624): a request whose matching record was rejected is never run and now fails the chain (exit 1, MCP `chain_journeys` error) instead of passing because an empty run list had no failures. The result reports `requests: { total, ran }`; an intentionally empty request batch still succeeds. A `url` handoff field may declare exact data `origins`, validated as data instead of against the browser origins, so a localhost-only run can carry an external reference URL without being allowed to visit it. Linked `journey readiness` replay fails with the first rejection named (`<key>: <field> <code>`), and prove's consumer hint names it too.
