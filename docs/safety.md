# Safety model

Jevitate drives a real browser against a real app, sometimes under a model's direction. These are
the guardrails that hold whatever a model proposes. Each is enforced in code and covered by tests
that assert the refusal. [SECURITY.md](../SECURITY.md) lists the invariants whose regression is a
security bug, and how to report one.

**Only what you authorize.**

- Every run is restricted to an allowlist of origins: the `--url`'s own origin, or exactly the
  `--allow` origins you pass. It is checked before a browser opens and again during the run.
- MCP missions can only target a *promoted* mission target, a human act
  (`jevitate mission target promote`).
- `load run` refuses to start without `--authorized-origin`.

**Bounded.**

- Every autonomous loop has hard ceilings: `--max-actions`, `--max-decisions`, time budgets, and a
  no-progress detector. Coverage runs also stop on `--stall-timeout`.
- `jevitate check` enforces a total action, time and spend budget over a whole suite, and fails
  closed when spend cannot be measured.

**No dangerous clicks by default.**

- Session-ending (Sign out), destructive (Delete, Revoke, Rotate) and paid (Buy, Generate, Send
  invite) controls are refused by default. `--deny <pattern>` adds your own, and
  `--allow-destructive` lifts the default. A goal run may still click the one its goal asks for.
- Every write request a run fires is listed in the result (`sideEffects`). A repeat guard refuses
  re-firing the same write, and `--read-rpc` marks POST-based read RPCs so they are not mistaken
  for writes.
- Adversarial runs never target password fields, file inputs or log-out controls, and never use
  real PII or real recipients.

**Secrets stay out of models and artifacts.**

- Outbound model payloads pass a redaction guard that fails closed. `--secret` values, bound
  `--secret-field` values, TOTP seeds, fixture secret outputs and probe tokens are scrubbed from
  transcripts, Recordings, issue drafts and log evidence.
- Code, not the model, types a bound secret into a field. The model sees `«secret:VAR»`.
- `--storage-state` files go only to the browser. Artifacts record their path, never their
  contents.

**Page text is data, not instructions.** Model prompts carry a prompt-injection guard, and page
content is passed as untrusted data.

**A model never decides a verdict.** Defects come from hard signals, your success checks, your
invariants and your log matchers, all evaluated by code. A model's "this looks broken" is recorded
as advisory and never gates an outcome, heals a step or files a defect. Write and irreversible
steps are never auto-healed.

**Operator-only escape hatches.** Things that run code on your machine (`--before`/`--after`
shell hooks, `cmd:` log sources) need an explicit opt-in flag (`--allow-shell-hooks`,
`--allow-log-cmd`), come only from the CLI or local config, and can never be named by a model or
an MCP request.

Jevitate assumes you are testing systems you are authorized to test.
