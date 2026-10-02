---
"@jevitate/cli": minor
"jevitate": minor
---

Declared invariants can now state "what was saved is what reloads" (#295). A `network` observable can read the JSON payload the page SENT (`"request": "$.items[*].id"`, instead of the response's `"json"`), and the expression language has `sameList(a, b)`: two `[*]` lists hold the same items in the same order. For example, gate `sameList(savedOrder, reloadedOrder)` on `"when": { "op": ["reload"] }`. Values under credential-named keys (`password`, `token`, `secret`, `apiKey`, `otp`, `cvc`, card numbers…) are never read (they read as `"[redacted]"`), and every value is redacted like any other observable. A violation's detail now shows a list observable's items (up to 10). `sameList` is a reserved word. See docs/invariants.md.
