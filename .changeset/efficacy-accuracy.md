---
"@jevitate/cli": minor
"jevitate": minor
---

Verdict accuracy, measured on a seeded-defect lab (#644). A message form addressed to a recipient (a To or Contact field beside Message and Send) is no longer driven as a chat with the app (#638): the run types the requested text instead of the goal prompt, and doesn't wait 60s for a reply. Selecting the option that is already selected is an accepted no-op instead of a refusal that derailed the run (#639). A wizard step that changes only its progress indicator ("Confirmation 1 of 3" to "2 of 3") is told to the model as new text, so goal runs no longer abandon working wizards (#640). Usability no longer reports a stuck job for a completed 2xx write on a reusable form (#641), and reports `signal-repeated-advance` for avoidable repeated confirmation steps (#642). `jevitate check` reports desired-outcome target misses against the replay floor in `check.json` `outcomeTargets` (advisory, #643).
