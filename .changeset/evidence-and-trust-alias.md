---
"jevitate": minor
---

Bare-name alias for `@jevitate/cli` 0.30.0; it installs the same `jevitate` command, so the breaking changes apply. A pass with no job done check exits 2 under the default `doneCheckPolicy: "require"` (`"advisory"` in `.jevitate/project.json` restores 0), boundary runs exit 2 `inconclusive`, a done check that reads false exits 1, `journey verify --mutate` reports `sensitive` where it reported `proven` (`verdictLegacy` until 0.32.0), and mutation proof is advisory while the job done check is the gate. See the `@jevitate/cli` 0.30.0 notes.
