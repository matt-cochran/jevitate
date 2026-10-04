---
"@jevitate/cli": minor
"jevitate": minor
---

`--secret-field` can read a value delivered during the run (#324). `--secret-field 'label=Verification code=cmd:./read-code.sh --to ada@example.test'` together with `--allow-secret-cmd` runs the command in a shell when the field is about to be typed, and types its trimmed stdout, for example a one-time code read from a test mail outbox. The model sees only `«secret:CMD_VERIFICATION_CODE»`, the Recording records a redacted fill, and the value becomes a run secret the moment it is read, so every redaction seam scrubs it from then on. The command has 60 s. A failure, a timeout or empty output fails that type step with a reason that never quotes the output. Without `--allow-secret-cmd` a `cmd:` binding is refused. This is operator-only: never an MCP argument and never a suite option.
