---
"@jevitate/cli": patch
"jevitate": patch
---

A run whose start URL is still redirecting (a server redirect, then a page that immediately does `location.replace(...)`) no longer crashes before its first decision with "Execution context was destroyed". When a navigation replaces the page while its controls are being read, jevitate now waits for that navigation to settle and reads the controls again, up to 3 times, bounded by the render-wait ceiling. A page that never stops navigating ends the run fail-closed (blocked, "the page kept navigating") instead of being reported, and drafted, as a crash.
