---
"@jevitate/cli": patch
"jevitate": patch
---

`journey verify --plan` and `--mutate`, and `journey readiness` in `prove` mode, now honour the target's `safety.readRequests`, as `journey lint` and `journey review` already did. A POST the target declares a read no longer gets `skip` and `block-write` mutations, and an invalid targets file is refused with `E_TARGET_CONFIG`. (#763) A proof's receipt now records them, so changing them stales the proof, and a resume refuses a checkpoint made under others.
