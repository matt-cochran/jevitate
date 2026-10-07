---
"@jevitate/cli": patch
"jevitate": patch
---

Adversarial runs now submit a modal form whose submit stays disabled until its required fields are filled (#394). Before a submit probe (double-submit, boundary-submit, edit-cancel-save, act-while-pending), the other empty text fields get valid values, so the probe reaches the server instead of ending `insufficient-coverage`.
