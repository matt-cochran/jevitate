---
"@jevitate/cli": minor
"jevitate": minor
---

A save that answers success but never stores what was entered is no longer reported clean (#647). After a 2xx write, what the run typed counts as evidence for a report or a `done` only once a page loaded from the server since (a reload, or the page that lists it) shows it again; a page showing it right after the write may be the client's own echo. The first request to read it back costs the run nothing, and verifying a write never stops a run as no-progress. On the accuracy lab, a message the server accepted but never stored is now caught on 6 of 6 runs (it was reported clean before), with no new false alarms on the working variants. Content the run did not type (a prefilled import) is not covered yet (#649).
