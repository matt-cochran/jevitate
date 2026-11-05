---
"@jevitate/cli": patch
"jevitate": patch
---

With `HOME` pointing somewhere else, a command run in a directory under your account's home no longer takes that account's `~/.jevitate` for the project's. It writes to the `~/.jevitate` of the `HOME` in force.
