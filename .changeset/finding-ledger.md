---
"@jevitate/cli": minor
"jevitate": minor
---

Finding ledger (#195): `jevitate ledger add <result> <fp> [--ticket X]` stores what `verify-fix` needs to re-check a finding in the committed regressions store (`.jevitate/regressions/ledger/<fp>.json`). `jevitate ledger verify [fp...]` re-checks every entry, or the named ones, and `jevitate ledger list` shows them. `verify-fix` now works from a fingerprint alone: `jevitate verify-fix <fp>` replays the ledger entry when no `--result` is given. Entries hold only the redacted repro material: the finding and its Recording, the scope, the invariant and fixture specs, and the names of controls that sent writes. They never hold a storage state or its path. `--secret` refuses an entry that would contain a named value.
