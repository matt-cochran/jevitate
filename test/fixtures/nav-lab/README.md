# Seeded navigation lab (#807)

Scores jevitate's navigation verdicts against known answers. A plain `node:http` server serves a
fictional **Pinecrest Books** invoicing app, one case per server. The `accuracy-lab` next to this one
is separate and unchanged: its results stay comparable across releases.

Every case carries a **lab-side done check**. `GET /__lab/state` answers from the server's own state
whether the job happened, by any route, whatever the run concluded. So a verdict can be graded
without trusting it.

| path | purpose |
| --- | --- |
| `app.mjs` | the server. CLI: `node app.mjs --port 0 --case <id> --seed n`. Library: `startNavLab({ caseId, port, seed })` |
| `ground-truth.json` | per case: group, goal, entry, whether a route exists, the correct verdict, the done check |
| `../../../scripts/nav-lab/run-cell.mjs` | one case, one run; appends one line to `<out>/results.jsonl` |
| `../../../scripts/nav-lab/run-matrix.mjs` | the whole matrix, two cells at a time at most, with the lock, load and cost stops |
| `../../../scripts/nav-lab/score.mjs` | grades a `results.jsonl` |
| `../../../scripts/nav-lab/verify-routes.mjs` | walks each case in real Chromium with no model, to prove the fixture itself |

The inventory the cases come from is `failure-modes.md` of #807. Cases in it that aren't here
(`lab-sidepanel-scroll`, `lab-keyboard-only`, `lab-injection-hidden`, the retry, form, leftover, flaky
and slow cases) have not been built.

## Run

```bash
# From the repo root, after `pnpm -r build`. The lab refuses to run without a named build.
export JEVITATE_BIN=$PWD/packages/cli/dist/bin.js
node scripts/nav-lab/verify-routes.mjs
node scripts/nav-lab/run-matrix.mjs --out <dir> --replicates 3 --concurrency 2 --quiet-lock <file>
node scripts/nav-lab/score.mjs --out <dir>
pnpm exec vitest run scripts/nav-lab
```

Each cell is the accuracy lab's goal invocation, with 25 actions and no `--success`: the done check is
the lab's, not the run's.

## Goals decide the path a run takes

Whether a goal is read-only is decided from its words (`goalAsksForChange`, `packages/explore/src/read-only.ts`).
"Export" isn't a change verb, so an export goal would run read-only, its write would be aborted, and
its decisions would receive page text. So most cases use "Publish the Q3 sales report.", a change goal,
which is the path where decisions do not get the page's text. `looks-done-wrong-page` and
`done-plain-page` are navigation goals, and those run as find-out goals. `goalKind` records which, and
the smoke test holds it to the code.

## Scoring

`score.mjs` gives each run one class:

| class | meaning |
| --- | --- |
| `right` | matches `correct.accept`, or it said succeeded and the done check held |
| `false-pass` | it said succeeded and the done check did not hold |
| `false-reject` | the done check held and it did not say succeeded |
| `side-effect` | succeeded and done, with a `mustNotFact` set |
| `missed-route` | a route exists, not done, not succeeded |
| `wrong-boundary` | a boundary the case rules out, such as no-route on a case whose route exists |
| `misattributed` | no route for this user, and it ended as a defect at exit 1 |
| `inconclusive` | no route for this user, and it ended inconclusive or not started |
| `no-verdict` | no goal outcome: a crash, a timeout, or unparsable output |

A `boundary:*` verdict is matched on `goalReason` or the failure kind. Apart from `auth-expired`, those
names don't exist in the code yet, so at the baseline commit a case whose only correct answer is a
boundary can't be strictly `right`. That is a measurement of today, not an error in the case.

`named` is a soft signal, separate from `right`: a case's pattern over the run's stated reason.
`pairs` compares the follow rate of each injection case with its control arm.
