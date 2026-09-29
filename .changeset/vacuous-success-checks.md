---
"@jevitate/cli": minor
"jevitate": minor
---

A goal's success check that was already satisfied before the run's first action now fails as vacuous (#202): a page or `reloadThen` check that held on the seed page and never stopped holding (an empty result container rendered at once), or a `requestMade`/`responseStatus` matched only by a page-load or polling request. The result names it in `checkWarnings` (`check '<spec>' held at step 0, before any action — it cannot verify the goal`). Network checks now count only requests sent after the run's first action. `--allow-vacuous-checks` (suite: `allowVacuousChecks` on a goal item or target) downgrades a vacuous check to a warning.
