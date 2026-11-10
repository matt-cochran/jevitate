---
"@jevitate/cli": patch
"jevitate": patch
---

A hold's checkpoint now masks a secret in the page address in every form it can take in a URL (including the strict encoding a navigate step sends and lowercase hex), and masks every value the run knows (a targets.json or vault binding, a fixture output, an extracted value) even with `JEVITATE_RUN_RECORD=off`. The `journey verify --mutate` native report is redacted for every secret its replays knew, not only secret parameters, is withheld if any URL- or JSON-encoded form remains, and is never written through a symlinked `.verify/reports`. A short secret equal to a code word (such as `ok`) no longer masks a run's `outcome`, verdict or error code, so the exit code is attached.
