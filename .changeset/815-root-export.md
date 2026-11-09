---
"@jevitate/cli": patch
"jevitate": patch
---

`import("@jevitate/cli")` works from an install (#815). The root export, `dist/index.js`, is now bundled like the `jevitate` bin; it imported the private `@jevitate/playwright`, which is never published, and failed with `ERR_MODULE_NOT_FOUND`. The release pack imports it in an empty prefix holding only the declared dependencies and checks that `buildProgram` and `versionString` are present and that it reports the bin's build identity.
