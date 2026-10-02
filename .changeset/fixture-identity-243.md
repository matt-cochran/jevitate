---
"@jevitate/cli": minor
"jevitate": minor
---

Fixture identities (#243). A fixture step can authenticate as a named identity (`"auth": {"from": "cookies"|"localStorage", ..., "identity": "owner"}`) bound by `--fixture-identity <name>=<storageState>` (repeatable; `fixtureIdentity` over MCP and in a `check --suite` goal item) or by the origin's targets.json `personas.<name>.storageState`, separate from the mission's own session, so a fixture can mint an invite link as the owner while the mission opens it as a cold recipient. An unbound, unused or missing identity is refused before any browser or request (never a fall back to the mission's session); only the identity's storageState path is recorded (`fixtures.identities`), and verify-fix/regression capture re-mint as the same identities. `--url` also accepts a `${setup.*}` reference right after the origin when its value is a root-relative path (`http://host${setup.link}` with `/join/abc`); a bound value that would move the origin is refused. See docs/fixtures.md.
