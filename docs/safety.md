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
  The paid classifier reads only short, verb-led button and link labels: a chat question card or
  a radio/checkbox answer that merely contains "pay", "trial" or "upgrade" is not refused unless
  its label names a charge. A refused control is not offered to the model again in that run.
- A find-out goal (no `--success`) is read-only unless the goal asks for a change: write-flow
  controls are refused and the write requests an action fires are blocked. `--allow-writes`
  lifts it and `--allow-write <glob>` exempts a request path
  ([find-out goals](./success-checks.md#find-out-goals-no---success)).
- A hang's fresh-context replays never re-send a paid or destructive write. A replay path that
  clicks such a control (or matches `--deny`) is not replayed, and the hang (or `verify-fix`) is
  `inconclusive`. `--allow-destructive` does not lift this; `--hang-replay-writes` (or
  `safety.hangReplayWrites` in `~/.jevitate/targets.json`) does.
- Every write request a run fires is listed in the result (`sideEffects`). A repeat guard refuses
  re-firing the same write, and `--read-rpc` marks POST-based read RPCs so they are not mistaken
  for writes.
- Adversarial runs never target password fields, file inputs or log-out controls, and never use
  real PII or real recipients.

**gRPC-web/Connect reads.** gRPC-web, Connect and Twirp send every RPC as a POST, including pure
reads, so the method alone can't tell a read from a write. Code classifies a request as a write
unless: it isn't `POST`/`PUT`/`PATCH`/`DELETE` (GET/HEAD/OPTIONS are always reads); or it's an
RPC-shaped POST (`/<pkg>.<Service>/<Method>`, sent as gRPC-web/Connect/Twirp/protobuf/JSON, or with
no content type) whose method name starts with a built-in read verb — `Get`, `List`, `Search`,
`Find`, `Watch`, `Stream`, `Count`, `Describe`, `Read`, `Query`, `Fetch`, `Lookup`, `BatchGet` or
`BatchRead` (`GetItem`, `ListItems`, `BatchGetItems`, … ; `CreateItem`/`UpdateItem` are still
writes); or it matches an operator-supplied pattern — `--read-rpc <pattern>` (repeatable) or
`safety.readRequests` in `~/.jevitate/targets.json`: a pattern starting with `/` is a path glob
(`/api/search*`), any other pattern a glob over the RPC method (`Estimate*`, `pkg.Service/Estimate*`).
An unknown request is always a write — a misclassified read only costs a guard/finding; a
misclassified write could let a run repeat a real side effect.

```json
{ "http://localhost:5173": {
    "safety": { "readRequests": ["pkg.BillingService/Estimate*", "/api/search*"] } } }
```

```bash
jevitate explore --strategy goal --url http://localhost:5173/billing \
  --goal "check the plan estimate" --success 'visible:text=Estimated' \
  --read-rpc "pkg.BillingService/Estimate*" --real
```

`pkg.BillingService/EstimateCost`, sent as `application/connect+json` to
`/pkg.BillingService/EstimateCost`, does **not** start with a built-in read verb, so without the
pattern above it is treated as a write and refused/repeat-guarded like any other. `--read-rpc
"pkg.BillingService/Estimate*"` (or the equivalent `safety.readRequests` entry) marks it a read
explicitly — the same fix applies to any Connect/gRPC-web method whose name doesn't start with a
built-in verb (`Preview*`, `Recalculate*`, …).

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
