---
"@jevitate/cli": minor
---

`jevitate check` records the app's release label: `--app-version <label>` (else a valid
`JEVITATE_APP_VERSION`) is stamped next to `targetBuild` in the check record and the SARIF run
properties. The Journeeze catalog bundle v1 minor 1 exports it as the optional `check.appVersion`
(spec §2); an invalid label is refused before anything runs, and an invalid bundled value is left
out with a warning while the check still exports.
