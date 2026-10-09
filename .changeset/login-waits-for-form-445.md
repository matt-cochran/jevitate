---
"@jevitate/cli": patch
"jevitate": patch
---

`jevitate login` waits for a client-rendered sign-in form (#445): after the page loads it waits (within the login timeout) for a username or password field to appear before deciding none exists.
