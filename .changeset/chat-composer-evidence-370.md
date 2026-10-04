---
"@jevitate/cli": patch
"jevitate": patch
---

Goal runs no longer treat a form field as a chat composer just because its label contains a word like "Chat" or "Message" (#370). A field is offered the `send` op only when the page shows conversational evidence: a message transcript (`role=log`, a live region or repeated message bubbles) or a Send-style button next to the field. An answer editor's "Chat answer" textarea with Save/Publish buttons is now typed into, and the run presses the form's own Publish button.
