---
"@jevitate/cli": minor
---

Steps now record what a person saw on their target (#497). Both the recorder and Jev-authored recordings store each step target's role and visible label as `display` (`{ role?, name }`), which is display metadata only and never used to find an element. A credential field's label, or one that holds a secret, is never stored. Step descriptions read `click "Import"`. A step with only a test id reads `click [action import] (no recorded label)`. A new `migrateLabels` API backfills labels on existing Journeys by replaying them. Promoted Journeys it changes need re-approval.
