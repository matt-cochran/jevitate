---
"@jevitate/cli": patch
"jevitate": patch
---

Goal runs no longer refuse a confirm token typed into a freshly reopened dialog: the "already submitted into this field" guard now applies only to the same live field, and a value the field's label or dialog text asks for ("Type REINSTATE to confirm") is never a repeat (#366). Goal runs also accept a value built from words the goal dictates — quoted text, a parenthesised list, or the text after "a short description of", "describing", "saying" or "about" — instead of refusing it as an echo of the goal; copying the goal's instruction prose is still refused (#371).
