---
"@jevitate/cli": patch
"jevitate": patch
---

Adversarial `boundary-submit` asks whether a field's input is rendered as markup (#301). Its values now include two inert canaries with a fresh random token per submission: an HTML-injection canary (`<i data-jev-canary="T">jevT</i>`) and an attribute-break canary (`jevT" data-jev-canary="T`). They have no script, event handler or `javascript:` URL. The values also include an oversize (~100 KB) value, and the unicode value gains an RTL override and zero-width characters. Detection is DOM inspection only: after the submit settles, and again after a plain GET of the same in-scope page, the run looks for an element carrying the canary attribute. A hit is a `markup-injection` defect with `markupInjection: {field, payload, submittedOn, renderedOn, afterSubmit, afterReload, stored}` (stored vs reflected). A canary shown as escaped text is not reported. `verify-fix` returns `inconclusive` for this kind; re-run the mission instead.
