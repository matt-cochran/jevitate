---
"@jevitate/cli": patch
"jevitate": patch
---

A credential typed into a credential field is always stored redacted, wherever its value came from (#829). Before, redaction matched only values registered with `--secret` / `--secret-field`, so a password stated in the goal text ("Create an account with … and password …") was recorded in the clear: the Recording's fill held `{ redacted: false, value }` and its `intent` kept the goal verbatim. Now a value typed into a password input, a password / one-time-code / card autocomplete field, or a credential-named field is recorded `{ redacted: true }` and becomes a run secret before it is typed, so the Recording intent, transcript, later model calls, result, evidence, issue drafts and screenshots mask it. Replaying such a fill fails with `E_REDACTED_FILL`, naming the field and how to bind it (`--secret-field 'label=<Field>=env:VAR'` or a targets.json `secretFields` entry). If you have Recordings or Journeys made from goals that stated a credential, check them for the plaintext value, delete or re-record them, and rotate that credential.
