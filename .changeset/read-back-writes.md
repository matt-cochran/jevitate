---
"@jevitate/cli": minor
"jevitate": minor
---

A save that answers success but never stores what was entered is no longer reported clean (#647). After a 2xx write, what the run typed counts as evidence for a report or a `done` only once a page loaded from the server shows it again: before such an ending rests on a page showing it, Jevitate reloads that page once and checks (a verification read, not recorded as a Journey step). A page showing the value right after the write may be the client's own echo. On the accuracy lab, a message the server accepted but never stored is now caught on 6 of 6 runs (1 of 6 before), with no new false alarms on the working variants. Content the run did not type, such as a prefilled import, is not covered yet (#649).
