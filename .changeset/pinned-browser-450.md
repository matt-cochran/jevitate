---
"@jevitate/cli": minor
"jevitate": minor
---

One shared, pinned browser (#450). `jevitate install-browser` installs the Chromium revision jevitate pins into the shared browsers directory (honouring `PLAYWRIGHT_BROWSERS_PATH`) without Playwright's stale-browser cleanup, so other projects' browser revisions are never removed. `jevitate browser-path` prints the pinned revision, the directory and the executable (`--json`, `--export` for project scripts). `jevitate doctor` reports whether the pinned browser is installed, and the missing-browser launch error points at `jevitate install-browser`.
