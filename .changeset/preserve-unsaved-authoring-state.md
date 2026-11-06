---
"@jevitate/cli": patch
---

Defer automatic persistence reloads while an editor, dialog, or frame may hold unsaved state. Report persistence as inconclusive instead of discarding a draft or treating an ephemeral review screen as lost server data. Explicit Journey read-back checks remain required. Keep the stalled-import browser clock synchronized in the host-pressure regression fixture.
