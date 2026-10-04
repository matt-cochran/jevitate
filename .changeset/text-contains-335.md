---
"@jevitate/cli": patch
"jevitate": patch
---

Visible-text success checks can match part of an element's text (#335, #327). In a `--success` descriptor, `text=` matches an element's whole text exactly, so `textIncludes:text=This demo has|This demo has` never found `<h1>This demo has ended</h1>` and reported "did not hold" although the page showed it. The new `textContains=<part of the text>` key matches a substring, case-insensitively, including below-the-fold content (for example `textIncludes:textContains=This demo has|This demo has`). A failing exact `text=` check now says when some element contains the text and names the `textContains=` form to use. `text=` itself is unchanged.
