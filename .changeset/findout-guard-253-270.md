---
"@jevitate/cli": patch
"jevitate": patch
---

Find-out guard (#253, #270). A form submit is judged by the requests it sends, not by its shape: a lookup form's "Load" that only reads (GET/HEAD, a `Get*`/`List*` RPC, `--read-rpc`) is clicked, and a submit that writes is blocked at the network (a native form POST is answered `204` in the browser, so the page stays put). A goal with no `--success` whose text asks for a change is no longer read-only but never destroys on its own words: a destructive control is refused (no goal-word lift) and a destructive write request (`DELETE`, a `Remove*`/`Delete*`/`Revoke*` RPC, a `/remove`-like path segment) an action fires is blocked, unless `--allow-writes` or `--allow-destructive`.
