---
"@jevitate/cli": patch
"jevitate": patch
---

`journey verify --plan` and `--mutate`, and `journey readiness` in `prove` mode, now honour the target's `safety.readRequests`, as `journey lint` and `journey review` already did. A POST the target declares a read no longer gets `skip` and `block-write` mutations, and an invalid targets file is refused with `E_TARGET_CONFIG`. (#763)
