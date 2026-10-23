---
"@jevitate/cli": minor
"jevitate": minor
---

Verdict accuracy, measured. On a seeded-defect lab of 42 runs with known ground truth, goal-run precision rose from 64% to 90% and usability precision from 60% to 90%, while recall stayed at 100% (every planted defect still found). Inconclusive runs fell from 2 to 0, and the 42 runs take 6.5 minutes instead of 30. The changes:

- A message form addressed to a recipient (a To or Contact field beside Message and Send) is no longer driven as a chat with the app (#638): the run types the requested text instead of the goal prompt, and doesn't wait 60s for a reply after each send.
- Selecting a page default that is already selected is accepted once as a no-op instead of a refusal that derailed the run (#639). Re-choosing an option the run set itself, or a placeholder, is still refused (#273).
- A wizard step that changes only its progress indicator ("Confirmation 1 of 3" to "2 of 3") is told to the model as new text, so goal runs no longer abandon working wizards (#640).
- Usability no longer reports a stuck job for a completed 2xx write on a reusable form (#641), and reports `signal-repeated-advance` ("slowed", never a defect) when the same Continue / Next / Confirm is needed 3 or more times in a row (#642).
- `jevitate check` reports desired-outcome target misses against a clean replay's floor in `check.json` `outcomeTargets` (#643). Advisory: a miss never fails the check.
- The lab ships with the repo (#644): `test/fixtures/accuracy-lab`, `scripts/accuracy-lab/run-matrix.mjs` and `score.mjs`. `docs/accuracy.md` has the current rates and the remaining failure modes: a `done` judgment that can't separate finished from unfinished jobs (#645, so the threshold stays 0.75), and silent data loss reported as clean (#647).
