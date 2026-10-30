---
"@jevitate/cli": patch
"jevitate": patch
---

`jevitate login` selects and asserts a persona's declared `context: {organization, role}` before it captures the storage state — a labelled control or a "Choose your workspace" card — so the saved state reopens directly in that organization and role, with no chooser (#741).
