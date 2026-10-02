---
"@jevitate/cli": patch
"jevitate": patch
---

Goal runs stop looping on actions that can never make progress, and stop misjudging it. Controls behind an open modal and controls no scroll can bring into view (a closed panel translated off-screen) are no longer offered; a target that fails twice as covered or unreachable is withheld, and five failed actions in a row end the run naming the overlay (#272, #294). A `select` never re-chooses the selected option or a placeholder, and option matching tolerates dash spellings (#273). Retyping a field that changed nothing but its own value is no progress: a search box is submitted with Enter, any other field ends the run as stuck (#242). A `send` that started no request and changed nothing is a failed send, and background polling no longer keeps a reply wait alive (#241). A model `blocked` before any action is refused and, if it insists, ends `inconclusive` rather than `defects-found` (#237). A disclosure `<summary>` is a control, and controls the goal names survive the candidate cap (#287). Steps that were refusals or scrolls the app answered never make an app `ui-no-progress` hang (#276).
