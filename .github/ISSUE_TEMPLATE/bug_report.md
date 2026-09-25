---
name: Bug report
about: Something isn't working as expected
title: ""
labels: bug
assignees: ""
---

**What happened**
A clear description of the bug, with the exact command and any error output.

**Expected**
What you expected to happen.

**Reproduce**
Minimal steps (command + flags, and a minimal target if relevant).

**Result**
The run's `outcome` / `missionOutcome`, `reason`, and exit code. If you can, attach (or quote)
the relevant part of the `*.result.json` / `*.transcript.json` it wrote. Redact app data.

**Environment**
- Jevitate version (`jevitate --version`, which includes the commit):
- OS / Node version (WSL? say so):
- Browser (Playwright's Chromium, or `--browser-channel` / `--browser-executable`):
- Gateway: `--real` or `--fake-ai`

**Notes**
Anything else — logs, screenshots. Please redact any secrets.
