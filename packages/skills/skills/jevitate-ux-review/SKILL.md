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
  <class> [--persona <p>] [--job "<text>"] [--out <dir>] --json`. Analyzes a
  Recording you already captured (e.g. from `jevitate-record` or a successful
  `jevitate explore`). It launches no browser. `--app-class` is REQUIRED
  (e.g. `consumer`, `admin`, `internal`); `--job` sharpens relevance.
- LIVE, against an authorized target — `jevitate explore --strategy usability
  --url <authorized-url> --goal "<the job>" --app-class <class> [--allow
  <origin>] [--secret <value>] [--max-actions <n>] --real --json`. Drives the
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

## Reading the result

- The report is a set of findings, each with a `severity` (`info` | `minor` |
  `major`), a rubric `citation` (`source` + `ref`), and redacted evidence refs
  pointing at the screen/control it is about. Rank your summary by severity and
  lead with the `major` findings.
- Report findings as ADVISORY recommendations, with their citations — never as
  defects that block shipping, and never restate a finding without the rubric
  citation the tool attached (the citation is what makes it more than an
  opinion).
- An analysis that FAILED (`E_UX_ANALYSIS`) is a real failure to surface
  honestly — never fabricate a clean "no issues found" report from a failed run.
  Offline review over a bare Recording is coverage-limited (it sees only what
  the Recording captured — no live a11y tree, no runtime contrast); say so when
  the Recording is thin, rather than implying the flow is fully vetted.

## What you must never do

- Never present UX findings as pass/fail gates — they are advisory by design.
- Never emit or paraphrase a finding without its rubric citation.
- Never run the live mode against a production or unauthorized target — UX review
  is authoring/test-plane only.
- Never fabricate a clean report from a failed or empty analysis.
