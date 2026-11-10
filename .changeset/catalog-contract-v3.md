---
"@jevitate/cli": minor
---

Publish repository-catalog contract v3.0.0 under `contracts/jevitate-catalog/v3/`. It adds the job done check (`jobs[].done`) and typed Journey parameters (`type`, `enum`); because the closed v2 schemas refuse files that use them, v3 is a new contract major. The v1.0.0 and v2.0.0 contracts ship unchanged beside it. Catalog bundles now pin the v3 manifest in `catalogContract`.
