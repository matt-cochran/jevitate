---
"@jevitate/cli": patch
"jevitate": patch
---

The adversarial markup canary (#301) gives a just-submitted canary a bounded moment (up to 1.5 s) to render before reading the page, after the submit and after the reload (#319). A list the app fetches after a POST or a reload is no longer read before it arrives, so a stored markup injection on a loaded host is no longer missed or reported as only reflected.
