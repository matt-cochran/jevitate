---
"@jevitate/cli": minor
"jevitate": minor
---

New `--geolocation <lat>,<lng>[,<accuracy m>]` places the browser at a fixed position for "near me" pages (#329), for example `--geolocation 41.6376,-70.9036`. The `geolocation` permission is granted only to the run's allowed origins, so the page reads the position without a prompt. A malformed or out-of-range value is refused before any browser opens. It is available wherever `--viewport`/`--device` are (`explore`, `journey run|demo|annotate`, `load run`, `source run`, `verify-fix`, `regression capture|run`, `demo`), except `mission queue`. Over MCP it is the `geolocation` argument.
