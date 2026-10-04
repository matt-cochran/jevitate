---
"@jevitate/cli": patch
"jevitate": patch
---

A `cmd:` secret field's command runs at most 3 times per run (#359). Retries used to re-run it without limit, and a read-the-code command usually has side effects: it consumes the code, marks a message read, or polls a rate-limited outbox. Past the limit, typing that field fails with a reason naming the limit, and the command doesn't run again. The limit is per field. `--secret-cmd-attempts <n>` changes it. Like `--allow-secret-cmd`, it is never an MCP argument or a suite option.
