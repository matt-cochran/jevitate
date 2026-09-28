---
"@jevitate/cli": patch
"jevitate": patch
---

Find-out answers must answer the question (#223). An answer is now rejected when its quote is only an action or label name (a button, a form field's label, or a navigation/header/footer or repeated link; a link in the page's content, such as an item title in a list, still counts as content), or when it sits on an error page (the document answered HTTP 4xx/5xx, or its heading or title says not found / 404 / error). Such a run ends "answer not found". An independent Jev check, "does this quote answer the goal's question?", can veto an answer that code grounded, but it can never approve one on its own. A `<textarea>` value, or the text of a contenteditable field, now grounds an answer as a form field value, the same way an input's value does.
