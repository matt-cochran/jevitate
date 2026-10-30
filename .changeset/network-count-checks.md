---
"@jevitate/cli": patch
"jevitate": patch
---

Network success checks may bound how many requests matched (`count=exact|min|max:<n>`) and declare the JSON request-body fields a matching write must carry (`body=name:predicate,…`). Matching compares field names and JSON types captured in memory — never values — and a failed run names each declared shape it did not see (#743).
