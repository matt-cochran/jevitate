---
"@jevitate/cli": patch
"jevitate": patch
---

`campaign run`'s preflight also checks the session's declared persona context and the host's readiness before any mission (#746): a job whose session's personas-file `context` (`{organization, role}`) does not match the context its Journey declares is refused with `E_CAMPAIGN_PREFLIGHT` (only the session file's basename is reported), and a starved host is refused with `E_HOST_STARVED` rather than folded into the campaign preflight. The default start-URL probe is now the HTTP origin-readiness probe: only DNS/connect failures and HTTP 5xx (or no response) are unreachable, so a 401/403 auth wall on the origin root still passes. `campaign run` also takes `--ignore-host-load` (MCP `run_campaign` `ignoreHostLoad`, forwarded to every mission) to start on a starved host. `--skip-preflight`/`skipPreflight` still records `preflight.skipped`.
