---
"@jevitate/cli": patch
"jevitate": patch
---

Goal runs no longer refuse a click as a "repeated side effect" just because an earlier control had the same label. The repeat guard now identifies an action by its route, the element and its context (form, dialog, and the screen heading above it), and names it by the request it actually sent (method + templated path), so a "Continue" on one screen that posted `/api/a` no longer blocks a different "Continue" that posts `/api/b`. Clicking the same control on the same screen again is still refused, and a write still in flight is still waited for.
