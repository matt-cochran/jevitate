---
"@jevitate/cli": patch
"jevitate": patch
---

Goal runs now notice when an action's only effect is new text on the page, such as a chat reply or the next question in a wizard (#390). The model is told what text appeared (redacted like other page evidence), and the step counts as progress instead of "the page did not change". Text that only changes its digits, like a counter, is ignored.
