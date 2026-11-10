---
"@jevitate/cli": patch
"jevitate": patch
---

A fresh install gets the tested Playwright (#825). `@jevitate/cli` depends on `playwright` 1.63.0 exactly, the version the release gate ran, where `^1.49.0` let a new install float to an untested one. An upgrade that changes the pinned Playwright needs `jevitate install-browser` once; until then browser commands refuse and name it. The release pack refuses a tarball whose Playwright is a range or differs from the frozen lockfile.
