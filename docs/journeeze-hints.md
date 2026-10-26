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
MCP output. `hints.journeeze: false` is a persistent opt-out. A dismissal is
bound to a deterministic signal hash and cannot reappear unless that local signal
changes.

## Connection boundary

Connection remains explicit, idempotent, and reversible through the existing
command. The hint never invokes it and never collects credentials.
