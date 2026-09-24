# ux-quality harness

Tunes and calibrates the `@jevitate/ux` quality grader (the independent second Jev pass that
labels each candidate finding `actionable` / `relevant-minor` / `generic` / `wrong`, gating what
`--show`/`--min-confidence` surface). Everything here runs OUTSIDE the shipped CLI — a
committed-corpus, opt-in regression plus manual calibration tooling. See issue #97 for why this
exists: a quality grader's calibration on one app does not automatically generalize to another, so
this harness exists to *measure* that, not assume it.

## Files

| File | Purpose |
|---|---|
| `capture.mjs` | Drives real (or fixture) targets and captures screens into a `corpus/*.json` file (see **Corpus format**). |
| `run.mjs` | Replays a captured corpus through the full pipeline (Jev judgment → specifics → code adjudication → dedupe → independent grade), N times, one result file per app per run. |
| `regrade.mjs` | Re-grades saved run results with the CURRENT grader (so every prompt iteration is measured with the same grader version). |
| `metrics.mjs` | Per-app grade distribution + run-to-run consistency (Jaccard of shown findings, label stability) for one or more tags. |
| `grader-eval.mjs` | Validates the grader against **human/model labels** — `legacy` mode (pre-fix dogfood CSV) and `hand` mode (see **Labels format** below). This is where inter-rater kappa and per-app precision/recall are computed (issue #97). |
| `stats.mjs` | Pure statistics functions used by the above: Cohen's kappa (`kappa`), Fleiss' kappa (`fleissKappa`), a named-multi-rater wrapper (`interRaterAgreement`), precision/recall (`precisionRecall`), run-to-run consistency (`consistency`), Jaccard (`jaccard`). |
| `gateways.mjs` | Live Jev/gen gateway wiring shared by the scripts above. |
| `corpus/` | Captured screens (`run.mjs`/`grader-eval.mjs legacy` input) and target lists (`capture.mjs` input). |
| `labels/` | Hand-labeled ground truth for `grader-eval.mjs hand` (see **Labels format**). |
| `baseline.json` | The committed regression baseline `packages/cli/src/ux-quality.integration.test.ts` checks against. |

## Corpus format (`corpus/*.json`)

A captured corpus (written by `capture.mjs`, read by `run.mjs` and `grader-eval.mjs legacy`) is:

```json
{
  "capturedAt": "2026-09-24T03:57:10.402Z",
  "screens": [
    {
      "app": "preveti",
      "id": "workspace",
      "split": "tune",
      "url": "https://…",
      "job": "…the user's task…",
      "appClass": "consumer",
      "controls": [ { "index": 0, "role": "link", "name": "Home", "tag": "a", "inputType": null, "enabled": true, "summary": "link \"Home\"" } ],
      "visibleText": "…"
    }
  ]
}
```

- `app` groups screens into one journey per app — `run.mjs` analyzes each app's screens together
  as one multi-screen journey.
- `split` is free-form (`"tune"` = the app the grader/threshold was tuned on, `"holdout"` = a
  different app used only to check generalization). It is carried through into run results and
  `metrics.mjs`'s output but not otherwise enforced.
- `appClass` MUST match the values used by `--app-class` / `AppContext.appClass` at runtime —
  it drives rubric applicability AND (issue #97) the calibration guardrail in
  `packages/ux/src/calibration.ts`.

`corpus/targets.example.json` is the CAPTURE-time input (URLs/jobs/steps to reach each screen),
not the captured corpus itself — see `capture.mjs` for its shape.

## Labels format (`labels/`) — multi-app, multi-rater

**Multi-app layout (preferred, issue #97): one subdirectory per app, one file per rater:**

```
labels/
  preveti/
    human-2026-09-23.json
    human-2026-10-01.json      # a second independent rater ⇒ inter-rater kappa is computed
    model-gpt.json              # a model rater works too — "rater" just means "label source"
  preveti-site/
    human-2026-09-23.json
  jevitate-site/
    human-2026-09-23.json
```

Each rater file is a JSON array:

```json
[
  { "key": "nielsen-5|/decisions|link \"Raise Pro to $149\"", "label": "wrong", "note": "…observation/rationale…" }
]
```

- `key` matches `findingKey()` in `stats.mjs`: `${rubricItemId}|${route}|${controls-or-quotes}` —
  the same key a grader-graded finding in a `run.mjs` result carries, so labels line up with runs
  without re-running anything.
- `label` is one of `actionable` / `relevant-minor` / `generic` / `wrong` (`stats.mjs`'s `LABELS`).

**Legacy flat layout (still read, single implicit rater): `labels/<app>.json`** — same array shape,
directly under `labels/`, no subdirectory. `grader-eval.mjs hand` reads both shapes from the same
`labelsDir` in one pass (a bare `<app>.json` file is treated as a lone rater named `rater1`).

Run it with:

```sh
node packages/cli/scripts/ux-quality/grader-eval.mjs hand <resultsDir> <tag> packages/cli/scripts/ux-quality/labels
```

For each app it prints:
- inter-rater agreement — Cohen's kappa (exactly 2 raters) or Fleiss' kappa (3+), only when the app
  has 2+ rater files; with 1 rater it says so explicitly rather than omitting the section silently;
- grader-vs-each-rater agreement (4-class accuracy/kappa + show/hide binary accuracy/kappa +
  confusion matrix, as before);
- the grader's "shown" (actionable/relevant-minor) precision/recall against the rater labels.

Then rolls the same precision/recall up **per app** and across all apps.

### Current state of the real `labels/` corpus (honest as of this writing)

Every app directory in `labels/` currently has exactly ONE rater file — there is no second
independent human (or model) rater yet, so `grader-eval.mjs hand` will correctly report "only 1
rater set" and skip the kappa line for each of them. Building the machinery (this harness) does
NOT by itself produce a second rater's labels — that still needs a human (or a second, independent
model pass) to actually label the same findings. See issue #97's "Suggested fix" and the "Rules"
section of the tracking task for why this PR stops at the machinery.

## Calibration guardrail (issue #97)

`packages/ux/src/calibration.ts` tracks which `appClass` values have ANY measured evidence behind
`DEFAULT_MIN_CONFIDENCE`/the grader's labels (today: `"consumer"` only, and even that only weakly —
see its doc comment). `buildReport()` (`packages/ux/src/report.ts`) always folds a calibration
caveat into `report.headline` and `report.calibrationCaveats`, computed from the target's
`appClass` — a target outside the corpus, or only weakly inside it, is never presented as if the
threshold generalized to it. `ux.minConfidenceByAppClass` in `~/.jevitate/config.json` lets an
operator set a per-`--app-class` cutoff once a real multi-rater run in this harness backs one;
today's global `DEFAULT_MIN_CONFIDENCE` remains the fallback wherever no such data exists.

## Running

```sh
# capture a corpus
node packages/cli/scripts/ux-quality/capture.mjs corpus/targets.example.json corpus/my-corpus.json

# replay it N times
node packages/cli/scripts/ux-quality/run.mjs corpus/my-corpus.json /tmp/ux-results --runs 3 --tag my-tag

# per-app grade distribution + consistency
node packages/cli/scripts/ux-quality/metrics.mjs /tmp/ux-results my-tag --min-confidence 0.3

# grader vs hand labels (inter-rater kappa + precision/recall, issue #97)
node packages/cli/scripts/ux-quality/grader-eval.mjs hand /tmp/ux-results my-tag packages/cli/scripts/ux-quality/labels

# grader vs the pre-fix legacy calibration CSV (one tuning app)
node packages/cli/scripts/ux-quality/grader-eval.mjs legacy packages/cli/scripts/ux-quality/corpus/cross-app-2026-09-24.json packages/cli/scripts/ux-quality/corpus/legacy-labels.json
```

Live gateways need `TYPESAFE_API_KEY`/`OPENROUTER_API_KEY` (see `gateways.mjs`); the opt-in vitest
regression (`packages/cli/src/ux-quality.integration.test.ts`) needs `RUN_UX_QUALITY=1` on top.
