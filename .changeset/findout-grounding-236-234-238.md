---
"@jevitate/cli": patch
"jevitate": patch
---

Find-out grounding (#236, #234, #238). Numbered-list markers at a line's start are formatting, never stated figures, and a claim's inflected word is said by its quote ("not subscribed" over "No subscription"). A multi-line quote grounds when every line is on the same observed page in order (a list of section headings); otherwise the rejection says what a quote must be, and an identical rejected re-report is named as a repeat. A goal that asks whether something exists may now be answered "none exists": when the generator finds no answer, code accepts `not present — none of the pages seen shows it (pages seen: …)` (`answer.absent: true`, `answer.searched`) once the run has seen at least half of its top-level navigation (never fewer than 2 pages; 2 distinct pages without a navigation); below that floor the report is refused naming the unseen pages, and a run that ends there is `inconclusive` (`failure.kind: "insufficient-coverage"`), never `blocked`/`defects-found`.
