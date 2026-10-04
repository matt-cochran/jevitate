---
"@jevitate/cli": patch
"jevitate": patch
---

A jevitate run that is signalled by pid only (Node's `spawnSync(…, { timeout })`, `kill <pid>`) no longer leaves Chromium behind: on SIGTERM, SIGINT or SIGHUP it writes its partial result, closes every browser it launched (SIGTERM, a 1 s grace, then SIGKILL of the browser's process tree), and exits 143/130/129. If jevitate's parent dies without forwarding a signal, jevitate now notices within about a second and shuts down the same way; set `JEVITATE_PARENT_WATCHDOG=off` for a run you leave behind on purpose with `nohup`.
