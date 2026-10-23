# Verdict accuracy: the seeded-defect lab

How often is a jevitate verdict right? The accuracy lab (#644) answers it against known ground
truth: a small app whose defects were planted on purpose, so every verdict is scored as a true or
false positive or negative.

## The lab

`test/fixtures/accuracy-lab/app.mjs` is a fictional CRM (a plain `node:http` server) with three
jobs: J1 update my profile, J2 send a message to a contact, J3 import contacts from a CSV. It runs
in one of five variants:

| Variant | What changes | A correct verdict |
|---|---|---|
| `clean` | nothing | no defect on any job |
| `j1-5xx` | Save returns 500 while the page says "Saved" | defect (both strategies) |
| `j2-stall` | Send does nothing: no request, no feedback | defect (both strategies) |
| `j3-effort` | three extra "Confirmation n of 3 / Continue" screens before Import | no defect; usability reports the extra effort |
| `j3-deadend` | Import is disabled with no explanation | defect (both strategies) |
| `j2-phantom` | Send answers success and shows the row, but nothing is stored | defect (silent data loss) |
| `j3-phantom` | Import shows the rows, but nothing is written | defect (silent data loss) |

`ground-truth.json` holds the expected verdict per variant and strategy, and
`test/fixtures/accuracy-lab/README.md` explains how cells are scored.

## Run it

The cells make real model calls, so the lab is not part of CI. Run it on a quiet machine: a starved
host turns cells `inconclusive` (see [A starved host](./outcomes.md)).

```bash
# 42 cells: clean × J1–J3 and each seeded variant on its job, × goal/usability, × 3 replicates
node scripts/accuracy-lab/run-matrix.mjs --out /tmp/lab            # the global `jevitate`
JEVITATE_BIN=packages/cli/dist/bin.js node scripts/accuracy-lab/run-matrix.mjs --out /tmp/lab-dev
node scripts/accuracy-lab/score.mjs --out /tmp/lab                 # --json for the raw report
```

## Results (2026-10-23)

Both builds, the same 42 cells, the same lab, a quiet host:

| | 0.21.1 | after #638–#643 |
|---|---|---|
| goal precision / recall / specificity | 64.3% / 100% / 54.5% | **90.0% / 100% / 91.7%** |
| usability precision / recall / specificity | 60.0% / 100% / 45.5% | **90.0% / 100% / 91.7%** |
| inconclusive cells | 2 | **0** |
| strategies agree (variant/job majority) | 6 of 7 | **7 of 7** |
| extra effort reported (`j3-effort` usability) | 0 of 3 | **3 of 3** |
| wall time for the 42 cells | 29.9 min | **6.5 min** |

Every planted defect was found by both builds: the gains are in precision (fewer false alarms) and
in runs that finish. Time fell because the message form no longer waits 60 s per send for a chat
reply (#638).

## Failure modes of the verdict pipeline (FMECA)

Occurrence is the share of the 42 cells each mode affected; severity rates the harm of the wrong
verdict to a team (a false "clean" is worse than a false alarm).

| Failure mode | Effect | Sev. | 0.21.1 | after | Mitigation |
|---|---|---|---|---|---|
| A message form read as a chat with the app: the goal typed as the message, a 60 s reply wait per send | false alarm or timeout on any app with a compose form | 3 | 12/42 | 0/42 | #638 — a recipient field makes it a form |
| Selecting the already-selected option refused | derailed runs; a dead end never reached (a missed defect) | 4 | 12/42 | 0/42 | #639 — a no-op, not a refusal |
| A wizard step changing only its counter read as "nothing changed" | working wizards abandoned: false alarm | 3 | 3/42 | 0/42 | #640 — a changed progress indicator is new text when nothing else appeared |
| A completed write on a reusable form reported as a stuck job | false usability alarm | 2 | 2/42 | 0/42 | #641 |
| Avoidable steps unreported | effort invisible; agents disagree | 2 | 3/42 | 0/42 | #642 — `signal-repeated-advance` |
| `done` rejected just under `GOAL_MET_THRESHOLD` (p 0.69–0.74 after a completed job) | false alarm | 3 | 2/42 | 2/42 | open (#645): the judgment cannot separate complete from incomplete jobs (see below) |
| A 2xx write that did not persist accepted as done | false clean: silent data loss reported as success | 5 | — | 5/11 phantom cells | open (#647): verify the write persisted |

The counts come from the cells' transcripts; one cell can show more than one mode. The remaining
mode is the next experiment: lowering the threshold trades false alarms for false "succeeded"
verdicts, so it needs calibration data, not a guess.

## Done calibration and silent data loss (#645)

Two variants make a job look finished when it is not (`ground-truth.json`, defect class
`silent-loss`): `j2-phantom` answers Send with success and shows the row but stores nothing, and
`j3-phantom` shows the imported rows but writes nothing. They supply the missing negatives for
calibrating `done` (`GOAL_MET_THRESHOLD`, 0.75), and they refuted the idea that the threshold is too
strict. Over 92 labelled done decisions (2026-10-23, the after build; 11 on incomplete jobs):

| threshold | done accepted on an incomplete job | done rejected on a complete job |
|---|---|---|
| 0.65 | 11 | 9 |
| 0.70 | 9 | 11 |
| 0.75 (current) | 5 | 20 |
| 0.80 | 3 | 26 |

The goal judgment scores incomplete jobs 0.66–0.95 and the rejected complete ones 0.69–0.74, so no
threshold separates them; lowering it would add false "succeeded" verdicts. `j2-phantom` goal runs
ended `clean` / `succeeded` on 3 of 3 cells: a write that answered 2xx but did not persist is not
caught. The lever is code evidence that a write persisted (read it back after a reload), not the
threshold (#647).

## Lessons from building it

- The first after-fix run showed the `clean` variant was not clean: imported contacts never reached
  the Contacts page, and jevitate's runs said so. Ground truth is a hypothesis too.
- Agent effort measures the agent as much as the app: the same wizard took the usability agent 6,
  18 and 18 actions on 0.21.1. Only a clean replay is a machine floor (#469, #643).
