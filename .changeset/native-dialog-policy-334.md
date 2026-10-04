---
"@jevitate/cli": minor
"jevitate": minor
---

Native dialogs now follow a policy and are logged (#334). `explore --dialogs accept` (or `"dialogs": "accept"` in a target's `safety` in targets.json) confirms a `window.confirm` or `prompt` raised by an action, so a confirm-gated action ("Revoke consent?") sends its request. A dialog whose message names a session-ending, destructive or paid action the run may not take (no `--allow-destructive`, and the goal doesn't ask for it), or that matches a `--deny` pattern, is still dismissed. The default stays `dismiss`, as before. Every native dialog an action raises (type, message, accepted or dismissed, and why) is now recorded on that step's transcript entry (`dialogs`) and shown to the model.
