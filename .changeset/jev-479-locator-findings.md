---
"@jevitate/cli": minor
---

Catalog bundle export (Journeeze) emits one locator finding per brittle element of the exported
Journeys: catalog bundle v1 minor 1 adds the optional `finding.locator` object (element, attribute,
testId, fix, steps) on `kind: "ux"` / claim `other` / producerClaim `locator-brittle` findings,
derived from locator health and de-duplicated across steps and Journeys.
