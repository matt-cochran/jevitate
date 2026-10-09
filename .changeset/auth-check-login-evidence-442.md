---
"@jevitate/cli": patch
"jevitate": patch
---

`--auth-check auto` needs sign-in-form evidence (#442). A visible password field alone (an "App secret" or API-credentials form) no longer marks a session as expired; the page must be on a login-like URL, or show a password field together with a username/email field or a sign-in button. `jevitate login`'s default success wait uses the same rule.
