---
"@jevitate/cli": patch
"jevitate": patch
---

Request path globs accept `{a,b}` alternation (#325). For example, `--success 'requestMade:POST /api.v1.Calendar/{Reschedule,Cancel}Appointment'` holds for either RPC, where the `/*Appointment` workaround also matched `GetAppointment`. Braces nest and combine with `*` and `**`. A brace group with no comma (`/users/{id}`) is still literal, and a pattern may expand to at most 64 alternatives (more is refused when the spec is parsed). The same globs are used by `--route` capability scopes.
