# Security Policy

Jevitate drives real browsers and can handle credentials, so we take its
security posture seriously.

## Reporting a vulnerability

Please report suspected vulnerabilities **privately** — do not open a public
issue. Use GitHub's private vulnerability reporting:
**Security → Report a vulnerability** on this repository
(https://github.com/matt-cochran/jevitate/security/advisories/new).

Include what it affects, reproduction steps, and impact. We aim to acknowledge
within a few days and will coordinate a fix and disclosure with you.

Please describe the class of issue rather than including a working exploit or a
step-by-step extraction path.

## Security posture (what the code guarantees)

These invariants are enforced in code and covered by "asserts-it-refuses" tests;
a regression in any of them is a security bug:

- **Credentials/secrets never reach a model.** Outbound model payloads pass a
  redaction guard and fail closed if it cannot run.
- **Authorized-origin-only.** Exploration and journey runs refuse any URL outside
  an explicit allowlist, checked before a browser is opened and again mid-run.
- **Bounded exploration.** Every autonomous loop has hard action/decision
  ceilings and no-progress detection — it cannot run unbounded.
- **Model judgments are advisory.** A model's opinion never unilaterally
  concludes a defect, heals a step, or gates an action; independent code
  adjudicates.
- **Write/irreversible steps are never auto-healed**, and distributed-source
  journeys run only through the trust/run-gate.

## Supported versions

Jevitate is pre-1.0; security fixes land on the latest published version.
