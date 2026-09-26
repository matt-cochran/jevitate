---
"@jevitate/cli": minor
"jevitate": minor
---

Truthful outcomes (#209) — a published contract change. A run that proved nothing is never `clean`, its reason is named, and every defect is in `defects`:

- **Goal:** a new `failed` outcome (exit 1, folds onto `defects-found`) for a run whose model said `done` but whose independent success check then failed, with `failure.kind: "success-check-failed"` naming the check. It was `blocked`, which now only means the loop gave up. A run whose only failing checks are vacuous (#202) is now `inconclusive` (exit 2), with `failure.kind: "vacuous-check"` instead of `blocked`. Its check detail no longer ends with "held on the final page". While a check is still pending (a `reloadThen`, or a check that has held since before any action), the transcript records the model's `done` as "accepted provisionally" instead of "goal verified by success-condition".
- **Usability:** a review whose job was never completed is `inconclusive` with `failure.kind: "job-incomplete"`. It used to be `clean`.
- **Feature:** a run whose every exercised control was unrelated to the feature (all `relevance=0`) is `inconclusive`, the same as the chrome-only case. Both the frontier `outcome` and `failure.kind` are `insufficient-coverage`. It adds `coverage.relevantActionsExercised` and `coverage.featureWords`.
- **Adversarial:** when every target control is refused by the safety policy, the run stops early with the new stop reason `targets-refused` and reports `coverage.controls.refused`. The failure names the refused controls and the flags that permit them (`--allow-destructive`, removing a `--deny`, or `--paid`/`--deny` to reclassify a control).
- **Coverage / exploratory:** each ending now has one name. The frontier outcome and the failure kind are both `insufficient-coverage` (#203's `insufficient-exploration` is renamed), and `exhausted` now means the frontier was fully covered. Links in the page body count as coverage, while only chrome links (`<nav>`/`<header>`/`<footer>`, or links repeated across pages) count as global navigation. The shortfall now says how to reach `clean`.
- **Defects:** a coverage run's frontier defects (`horizontal-overflow`, `judgment-flagged-state`) are now also in top-level `defects`, each with a `fingerprint` and `kind`.
- Goal outcomes map to exit codes in one place: `GOAL_OUTCOME_FOLD` / `outcomeExitCode()` in `@jevitate/domain`.
