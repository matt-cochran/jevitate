---
"@jevitate/cli": minor
"jevitate": minor
---

An import or other write that answers success but keeps nothing is no longer reported clean when the run never typed what it sent (#649). After a 2xx write, the values in its request body that the page then lists (an import's rows) must show again on a page loaded from the server before a `report` or `done` can rest on them, and the run is told when one does. A done whose writes the app was seen to keep this way now needs only even odds from the advisory page judgment instead of 0.75, which removes the false alarms on complete jobs scored just under the threshold (#645). On the accuracy lab: the phantom import is caught on 4 of 4 runs (1 of 6 on 0.22.0) and the phantom message on 4 of 4, with all 20 clean runs clean.
