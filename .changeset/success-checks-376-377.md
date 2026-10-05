---
"@jevitate/cli": patch
"jevitate": patch
---

A `textIncludes` check whose target matches several elements (for example `text=Coming soon` on a page of badges, one of them inside a closed section) now holds when any visible match contains the text, instead of failing because the target was not unique; hidden matches never decide it. `--allow-vacuous-checks` now also counts a check that already held on the start page under `--success-when held` and `each`, so a run whose start page already shows the goal succeeds without acting. A `blocked` reported while the success checks already hold is no longer refused as "nothing tried yet"; that refusal applies only while the checks do not hold.
