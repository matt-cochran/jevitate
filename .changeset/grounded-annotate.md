---
"@jevitate/cli": patch
---

Ground `journey annotate` goal and success-criteria drafts in replay evidence (#755). The `journey.goal` brief now receives the Journey's existing assertions (step postconditions and end-state checks) alongside the final page, and code drops any drafted success criterion whose quoted text or claimed state neither the final page nor an assertion shows — reporting it as `unverifiableCriteria` in the JSON result. When every drafted criterion is unsupported, the draft falls back to one minimal criterion derived from an existing assertion (or none).
