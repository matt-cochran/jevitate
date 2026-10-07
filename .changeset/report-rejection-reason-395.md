---
"@jevitate/cli": patch
"jevitate": patch
---

A goal run's rejected report keeps its real reason (#395). When the first answer was rejected and the retry found nothing, the run used to say "no answer was found on the pages seen" even though the answer was on the page. It now names the claim that couldn't be grounded and why, so the model can correct it instead of sending the same report again.
