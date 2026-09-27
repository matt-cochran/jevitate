---
"@jevitate/cli": patch
"jevitate": patch
---

Find-out goals answer from ordinary page text and form values (#207). A read-only find-out goal's decisions now carry the page's visible text (redacted, bounded), so an answer in a table cell or heading is seen and reported; a model `blocked` on such a goal first becomes one grounded report attempt on that page state (never an answerless "goal already met"). A form control's current value (never a password / one-time-code / bound secret field) is a grounding source: evidence records `source: "control-value"` and the control, while page-text quotes record `source: "page-text"`. A run whose report found no answer ends "answer not found (pages seen: …)" instead of a generic no-progress / blocked reason, and a literal "null" answer counts as no answer.
