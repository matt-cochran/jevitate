---
"@jevitate/cli": patch
"jevitate": patch
---

`journey verify --mutate` now accepts the same viewport, device, and geolocation context as Journey replay and applies it to the baseline and every mutation replay. The `verify_journey` MCP tool exposes the same arguments, so location- and device-dependent Journeys can produce mutation proof instead of being refused before browser launch (#721).
