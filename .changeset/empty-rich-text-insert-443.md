---
"@jevitate/cli": patch
"jevitate": patch
---

Typing into an empty rich-text editor works (#443). An edit to an empty `contenteditable` needs no anchor quote: it is a plain insert. A non-empty editor still requires the quote (fail-closed).
