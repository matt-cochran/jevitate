---
"@jevitate/cli": minor
---

A write jevitate itself blocked (its origin is not in `--allow`) is now an environment fault, never an app defect: console errors, failed requests and a stuck busy state it caused are linked to it (`causedBy`) and grouped under that blocked write in reports. jevitate warns when a blocked loopback origin differs from an allowed one only by `localhost`/`127.0.0.1` spelling or by port. `verify-fix` keeps the run's stored allow list unless you pass `--allow <origin...>` or `--env <name>`, and its report records the override (#484).
