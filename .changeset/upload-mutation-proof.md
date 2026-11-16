---
"@jevitate/cli": patch
---

`journey verify --mutate` now proves upload steps. When an upload checks its own outcome, verify skips that upload and requires the check to fail. Before this change, a Journey with descriptor-bound uploads (`--upload-fixture`) left each upload's claim unproven. An upload that only restates its own target, or makes no claim, still gets no mutation.
