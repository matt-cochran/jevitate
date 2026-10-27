---
"@jevitate/cli": patch
"jevitate": patch
---

`journey verify --mutate` now accepts the same viewport, device, and geolocation context as Journey replay and applies it to the baseline and every mutation replay. The `verify_journey` MCP tool exposes the same arguments, and verification receipts bind their proof hash to the effective browser and emulation context, so location- and device-dependent Journeys can produce mutation proof that cannot be reused under different coordinates or browser settings (#721).
