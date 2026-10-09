---
"@jevitate/cli": patch
"jevitate": patch
---

A closed off-canvas drawer is no longer treated as an open modal (#441). A dialog that is `inert`, `aria-hidden="true"` (or inside such an element) or wholly outside the viewport no longer scopes the page's controls, so a goal run on a page with an a11y-correct closed drawer sees the main page's controls instead of ending with "no interactive controls".
