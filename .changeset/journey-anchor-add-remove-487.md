---
"@jevitate/cli": minor
---

`jevitate journey anchor add <journeyId> --name <n> --step <n|stepId> [--description <text>] [--probe <text>]...` and `journey anchor remove <journeyId> --name <n>` edit a draft Journey's anchors without hand-editing `metadata.anchors`: the step's stable `stepId` is written at once, the name is checked against the anchor name rule, duplicates and unknown steps are refused (exit 64), and the remaining anchor lint issues are printed. `journey lint --fix` stamps the missing `stepId` of each anchor that references a step by number only and reports what it fixed. A promoted Journey is refused (its approval binds to the content hash): edit it as a draft and re-promote (#487).
