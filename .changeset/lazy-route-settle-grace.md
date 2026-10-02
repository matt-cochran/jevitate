---
"@jevitate/cli": patch
---

explore no longer blocks on code-split routes that briefly show an empty shell (#310). When a page settles before any interactive control has rendered, perception waits up to 3 s (scaled up on a throttled host, always within the render ceiling) for a control to appear, then lets the page settle again. Only after that does it count the page as having no controls. A page that really has no controls is still judged blank, just up to 3 s later.
