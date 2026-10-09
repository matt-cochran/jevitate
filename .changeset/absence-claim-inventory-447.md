---
"@jevitate/cli": patch
"jevitate": patch
---

Grounded answers can now state an absence (#447). A claim such as "there is no Launch control" names the missing thing (`absent`) instead of quoting text, and code checks it against every observed control, content link, form field, heading and page text. It is accepted, citing the observed controls, only when nothing matches the name or an inflection of it, and only for a goal that asks whether something exists. Any match rejects it. Positive claims whose quote is not on a page are still rejected.
