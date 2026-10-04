---
"@jevitate/cli": patch
"jevitate": patch
---

A goal run no longer types the goal's own instructions into a field (#338). A generated value that copies the goal's instruction prose, such as "add an answer and test it", is refused before it is typed and the model is told why, while values the goal quotes or gives with `exactly` are still typed as stated. Once the run reaches a section the goal names, navigation to sections the goal never names is listed last and marked off-goal, so the model stays in the goal's area. Every section the goal names can still be visited.
