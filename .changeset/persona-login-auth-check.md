---
"@jevitate/cli": minor
"jevitate": minor
---

New `jevitate login` signs a persona in with a username and password read from named environment variables (never from the command line), and saves its Playwright storage state with mode 0600. The login session records no trace, video, HAR or screenshot. Before a run that starts from a session, `explore` and queued missions now check that it is still signed in. An expired session ends the run at once as `inconclusive` with `failure.kind: "auth-expired"` and the persona's name; the login page is never explored. `--auth-check` configures the check. A persona whose personas file entry (or `.jevitate/personas.json`) carries `login` parameters is signed in again once instead.
