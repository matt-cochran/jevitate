---
"@jevitate/cli": patch
"jevitate": patch
---

A coverage run's `judgment-flagged-state` defects now say what was judged (#320). The reason was the fixed string "judgment flagged defect". It now reads `advisory: the judgment flagged a possible defect (p=0.9) after click "Delete" on <url>`, and the defect carries `judgment: { probability, after, shown }`, where `shown` is the first controls of the judged state as the judgment saw them, redacted. These flags remain advisory: they are listed separately in the summary (`· N advisory`) and never set the outcome or the exit code (#214).
