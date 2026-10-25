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

## Results (2026-10-24, 0.24.0)

0.24.0 (#667, #671), the same lab, 6 replicates per cell (108 cells, twice the usual 3), `run-matrix.mjs --replicates 6`:

| | 0.23.0 (3 replicates) | 0.24.0 (6 replicates) |
|---|---|---|
| usability precision / recall / specificity | 83.3% / 100% / 75.0% | **100% / 100% / 100%** |
| goal precision / recall / specificity | 100% / 100% / 100% | 96.2% / 100% / 95.8% |
| phantoms caught (`j2-phantom`, `j3-phantom`, both strategies) | 12 of 12 | **24 of 24** |
| extra effort reported (`j3-effort` usability) | 3 of 3 | 6 of 6 |
| strategies agree (variant/job majority) | 8 of 9 | **9 of 9** |

Precision is measured on the defect-free cells (`clean` J1–J3 and `j3-effort`), all 48 of which ran their full 6 replicates on a quiet host: no usability false alarm. The one goal false alarm (`j3-effort` r3) is #667's wander past Import ending in a rejected `report` instead of a `done`, which the no-write hint does not yet cover (#680).

Recall on `j2-stall` (both strategies) and `j1-5xx` usability is only partly measured. Other workloads starved the host (load up to 24/core) during those cells, and jevitate correctly declined to judge (`degraded-environment`, "load > 2/core — not an app finding", [A starved host](./outcomes.md)). Every one of those cells that ran on a usable host found its defect (j2-stall goal 2 of 2, j2-stall usability 4 of 4, j1-5xx usability 4 of 4), and none was reported clean. Data: `.delivery/experiments/lab-0.24.0-rc/` (a first pass is kept in `results.first-pass.jsonl`).

Before 0.24.0, an interleaved A/B on the J3 cells (20 replicates per arm, #670) showed that most of 0.23.0's 83.3% was sampling noise: the same 0.23.0 binary gave 3 J3 false alarms in 6 runs in the lab, then 2 in 40 and 3 in 24. #667 lowered `j3-effort` usability false alarms from 5 of 31 to 1 of 20. The same A/B found #671, a phantom send reported done after the run retyped the message into its composer.

## A/B (2026-10-24, #680, toward 0.24.1)

The single 0.24.0 goal false alarm (`j3-effort` r3) follows one path: Continue ×5, Contacts instead of Import, three scrolls that cannot move, then the no-progress last chance. Its note invited a report. The report was rejected, and the next step stopped the run. A no-write hint on the rejected report alone could not help, because the run never got another turn: report-only fix, 4 of 14 false alarms, against 2 of 14 on the interleaved base. #680 also puts the hint in the last-chance note of a write goal before any write succeeded.

| `j3-effort` goal, interleaved | 0.24.0 | #680 |
|---|---|---|
| false alarms | 5 of 28 (2 runs of 14) | 1 of 14 |
| runs that wandered to Contacts | 5 of 28 | 1 of 14 |
| guardrails on #680 (j2/j3-phantom, j3-deadend caught; clean J3 clean) | | 12 of 12 |

Every false alarm on both arms is a run that wandered to Contacts, so most of the difference is how often that detour happens. Fisher's test does not separate the arms at this size. The one #680 run that wandered was sent back to Import twice, found the wizard reset, and left again: the hint changes what the run does, but a reset wizard still defeats it. Data: `.delivery/experiments/ab680-{base,fix,base2,fix2}/` (local).

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
| A 2xx write that did not persist accepted as done | false clean: silent data loss reported as success | 5 | — | 5/11 phantom cells | #647: what the run typed counts only once a reload shows it again (`j2-phantom` caught 6/6, from 1/6); content it did not type is open (#649) |

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

#647 does that for what the run itself typed. After a 2xx write, a typed value counts as evidence
for a report or a `done` only once a page loaded from the server since shows it again. Before such an
ending rests on a page that shows the value, code reloads that page once (the read-back probe: a GET
through the actor, not recorded as a Journey step) and checks it. A value the reload shows is the
app's; one it no longer shows holds the ending. An interleaved A/B on 2026-10-23 (the same cells,
alternating builds): `j2-phantom` was caught on 6 of 6 cells (1 of 6 without #647); clean J1 stayed
clean on 6 of 6 with both builds, and clean J2 on 10 of 12 (11 of 12 without), the two misses being
the #645 near-threshold `done` and an existing grounding rule, not the read-back. Content the run did
not type, such as `j3-phantom`'s prefilled CSV, has nothing of the run's own to read back: #649.

#649 extends the read-back to what a write *sent*, whoever typed it. The string values in a 2xx
write's request body (bounded, redacted, held in memory only; values under credential-named keys are
skipped) await read-back when the page after the write newly shows them as text: an import's rows,
listed from its CSV. A form's untouched prefilled fields, which stay in their fields, do not. A value
the write's own route held as its source (the CSV field) is read back only by a page on another
route, since reloading the import page shows the source either way. When a page loaded from the
server shows the held values, the run is told so.

That alone held `done` on clean J3 too: the model opened Contacts, which listed the rows, but the page
judgment scored it 0.57–0.70, under 0.75 (#645). The read-back is the code evidence the threshold
lacked. A phantom write cannot pass it, so when every value the job's writes sent was read back, a
`done` needs only even odds (0.5) from the page judgment (#645).

Lab runs on 2026-10-23 (`clean` and phantom variants, goal and usability):

| cells | 0.22.0 | #649 read-back only | #649 + #645 |
|---|---|---|---|
| `j3-phantom` J3 goal (caught) | 1 / 6 | 6 / 6 | 4 / 4 |
| `j2-phantom` J2 goal (caught) | — | 1 / 2 | 4 / 4 |
| clean J3 goal (clean) | 4 / 4 | 2 / 4 | 6 / 6 |
| clean J3 usability (clean) | 2 / 2 | 0 / 2 | 4 / 4 |
| clean J1 + J2, goal and usability (clean) | 6 / 6 | 4 / 4 | 10 / 10 |

A limitation remains: rows already shown as page text before the write (a preview table) do not
await read-back, since a profile page that shows its saved name as text would otherwise be held.

## Lessons from building it

- The first after-fix run showed the `clean` variant was not clean: imported contacts never reached
  the Contacts page, and jevitate's runs said so. Ground truth is a hypothesis too.
- Agent effort measures the agent as much as the app: the same wizard took the usability agent 6,
  18 and 18 actions on 0.21.1. Only a clean replay is a machine floor (#469, #643).
