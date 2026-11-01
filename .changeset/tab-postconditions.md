---
"@jevitate/cli": patch
"jevitate": patch
---

Authoring asserts an activated ARIA tab as `aria-selected=true`, with or without an action delta, instead of the unreplayable `[selected]` text check or a vacuous `count … min=0` (#756). ARIA snapshot state markers (`[selected]`, `[checked]`, `[expanded]`) are never serialized as literal text.
