---
name: jevitate-ux-review
description: Produce ranked, cited, advisory usability findings for a flow — offline over a saved Recording (`jevitate ux <recording> --app-class`) or live over an authorized target (`jevitate explore --strategy usability --goal --app-class`). Use when a human wants a UX/usability critique of a journey, not a pass/fail functional test. Findings are advisory and never gate a run.
---

You produce a UX review: ranked, cited, evidence-anchored usability findings for
a flow. This is advisory analysis, not a functional gate — a UX finding never
fails a run or a build. Every finding is calibrated to an app class (a consumer
signup and an internal admin tool are held to different bars) and cites a rubric
item; the platform structurally cannot emit an uncited finding.

## Two modes — pick by what you have

- OFFLINE, over a saved Recording — `jevitate ux <recording.json> --app-class
  <class> [--persona <p>] [--job "<text>"] [--out <dir>] [--min-confidence <n>]
  [--show <labels>] --real --json`. Analyzes a
  Recording you already captured (e.g. from `jevitate-record` or a successful
  `jevitate explore`). It launches no browser. `--app-class` is REQUIRED
  (e.g. `consumer`, `admin`, `internal`); `--job` sharpens relevance.
- LIVE, against an authorized target — `jevitate explore --strategy usability
  --url <authorized-url> --goal "<the job>" --app-class <class> [--allow
  <origin>] [--secret <value>] [--max-actions <n>] [--min-confidence <n>]
  [--show <labels>] --real --json`. Drives the
  exploration loop toward the job (Jev makes the browsing decisions, not you)
  and reviews each observed screen against the rubric as it goes. Needs a
  gateway: `--real` (live, after `jevitate ai setup`) or `--fake-ai` (a
  deterministic pipeline smoke that will NOT produce a real review). No
  selection fails closed.

Prefer OFFLINE when a Recording already exists — it is cheaper, deterministic,
and touches no live site. Use LIVE only when there is no Recording and the human
authorized the target.

## Choosing inputs

- `--app-class` is the single most important calibration input — state the real
  class of the app under review; do not default to `consumer` to be lenient or
  `internal` to be harsh. If you don't know it, ask.
- For the live mode, write `--goal` as the JOB the user is trying to accomplish
  in plain language ("sign up and reach the dashboard"), the same as a goal-based
  exploration — the review is calibrated against how well the flow serves that
  job.
- Live mode is authoring/test-plane only and refuses an unauthorized target
  (`E_UNAUTHORIZED_EXPLORE_TARGET`). Never widen `--allow` beyond what the human
  authorized. Pass real secrets/PII via `--secret` so they stay out of every
  model call.

## Filtering what is shown

- `--min-confidence <0..1>` (also `JEVITATE_UX_MIN_CONFIDENCE`, or `ux.minConfidence` in
  `~/.jevitate/config.json`; default 0.75): findings below it are suppressed.
- `--show <labels>` (also `JEVITATE_UX_SHOW`, or `ux.show` in the config; default
  `actionable,relevant-minor`): which quality grades are shown. The grades are
  `actionable`, `relevant-minor`, `generic` and `wrong`.
- Both filters apply. Nothing is dropped silently: every suppressed candidate is
  counted in `report.suppressed`. Change a filter only when the human asks, and
  say which filter you changed.

## Reading the result

- Lead with `report.headline`. It gives the shown findings and "N suppressed (by
  rubric item: …)".
- Each finding is specific and grounded:
  - `observation`: what is wrong, naming the control, label or text, relative to
    the job.
  - `userImpact`: what it costs the user.
  - `recommendation`: a concrete change to that control or text.
  - `controls` and `quotes`: the implicated controls and verbatim on-screen text.
    Independent code checked that both exist on the screen.
  - `evidenceRefs`: only those controls, not every control on the page.
  - `route`, `screenId`, `occurrences` and `screenIds`: where it was seen. The
    same item on the same route and controls is one finding with a count.
  - `severity` (`info` | `minor` | `major`) and a rubric `citation` (`source` +
    `ref`).
  - `quality`: the independent grader's label and its confidence.
  - `confidence` with its `confidenceBasis`: violation × applicability ×
    grounding × agreement. Quote the observation and recommendation; don't
    paraphrase them into generic heuristic advice.
- Rank your summary by severity and lead with the `major` findings.
- `report.suppressed` counts what was not shown: `byReason`, `byRubricItem` and
  `byRubricItemRoute`. The reasons are:
  - `ungrounded`: named no control or text.
  - `rejected-evidence`: cited a control or text that is not on the screen.
  - `not-confirmed`: the specifics step found no concrete violation.
  - `below-min-confidence`
  - `quality-policy`: graded generic or wrong.
  Say how many were suppressed. `clean: true` only happens with zero findings
  AND zero suppressed, so never describe a report with suppressions as "no
  issues".
- `coverage.notApplicable` lists items whose rubric precondition did not hold,
  for example choice overload on a 2-control screen. Those items are evaluated,
  not skipped.
- Report findings as ADVISORY recommendations, with their citations. They are
  never defects that block shipping. Never restate a finding without the rubric
  citation the tool attached; the citation is what makes it more than an opinion.
- An analysis that FAILED (`E_UX_ANALYSIS`) is a real failure to surface
  honestly. Never fabricate a clean "no issues found" report from a failed run.
  Offline review over a bare Recording is coverage-limited: it sees only what
  the Recording captured, with no live a11y tree and no runtime contrast. When
  the Recording is thin, say so rather than implying the flow is fully vetted.

## What you must never do

- Never present UX findings as pass/fail gates — they are advisory by design.
- Never emit or paraphrase a finding without its rubric citation.
- Never run the live mode against a production or unauthorized target — UX review
  is authoring/test-plane only.
- Never fabricate a clean report from a failed or empty analysis.
