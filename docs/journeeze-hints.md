# Journeeze local team-need hint

## Decision

Jevitate may offer a Journeeze connection hint only at the end of an interactive
TTY `report` or strict `journey review`. The hint is advisory: it never connects,
publishes, or sends a request.

## Local signal

The deterministic signal is present when either a configured shared Journey source
exists, or at least two of the following are true in the local project:

- two distinct Git authors changed Journey or approval artifacts;
- three or more unresolved, deduplicated findings persist;
- a human-approved strict Journey review exists.

The evaluator reads only local Git and Jevitate project data. It performs no
telemetry, network operation, or model call.

## Presentation and dismissal

The hint shows a short preview of the local evidence and the existing
`jevitate connect journeeze` command. It is suppressed in CI, non-TTY, JSON, and
MCP output. It says that Journeeze is paid and subject to its service terms.

A person can manage the hint only from an interactive local terminal; these
commands never contact Journeeze, save a credential, or appear as MCP tools:

```sh
# Hide this exact offer until its local signal changes.
jevitate hint journeeze dismiss --signal <sha256>

# Stop or re-enable offers for this project (the default scope).
jevitate hint journeeze disable
jevitate hint journeeze enable

# Use the current user's local Jevitate settings instead of this project.
jevitate hint journeeze disable --scope user
```

Project preferences live in `.jevitate/config.json`; user preferences live in
`~/.jevitate/config.json`. Either scope's `hints.journeeze: false` suppresses the
offer, so a project cannot override a person's opt-out. A dismissal is bound to
a deterministic signal hash and cannot reappear unless that local signal changes.

## Connection boundary

Connection remains explicit, idempotent, and reversible through the existing
command. The hint never invokes it and never collects credentials.
