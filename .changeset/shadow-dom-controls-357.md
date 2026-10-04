---
"@jevitate/cli": patch
"jevitate": patch
---

Controls inside a web component's open shadow root (for example a floating bar mounted with `attachShadow({ mode: "open" })`) are now offered to goal runs and missions like any other control: they are named, checked for overlays that cover them, and clickable. Previously the overlay check stopped at the component's host element, so these controls were treated as covered and dropped, and a goal such as "press Get started" could never be reached. Controls in a closed shadow root remain out of reach, as before.
