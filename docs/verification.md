# Reproduction, verify-fix and regressions

How a finding is reproduced, how a fix is verified, and how a failure becomes a committed regression.

Every finding Jevitate reports carries its own reproduction: the Recording of the steps that led
to it and the step to replay up to. Three commands use it:

| Command | Answers | Exit codes |
| --- | --- | --- |
| `jevitate verify-fix --result <result.json> --fingerprint <fp>` | does this finding still happen? | 0 fixed · 1 still reproduces · 2 inconclusive · 4 intermittent |
| `jevitate regression capture --from <recording.json> --result <result.json> --fingerprint <fp> --id <id>` | commit this failure as a standalone regression | 0 committed · non-zero refused (with the reason) |
| `jevitate regression run <id>` | does the committed regression still fail? | 0 fixed · 1 reproduces |
| `jevitate ledger add <result.json> <fp> [--ticket X]` | keep what is needed to re-check this finding later | 0 stored · non-zero refused (with the reason) |
| `jevitate ledger verify [fp...]` / `jevitate verify-fix <fp>` | is every finding in the ledger (or this one) still fixed? | 0 fixed · 1 still reproduces · 2 inconclusive · 4 intermittent |

`verify-fix` works for every finding kind: hard signals (HTTP 5xx, uncaught exceptions, console
errors, failed requests), hangs, invariant violations and backend-log defects. In CI,
`jevitate check --suite` runs the same re-check from a suite's `verifyFix` entries (see
[ci.md](./ci.md)).

## Committing a regression: `regression capture` and `regression run`

`regression capture` turns a failing run into two files you can commit, `<id>.recording.json` and
`<id>.meta.json`, under `--dir` (default the repo's `.jevitate/regressions`). It first replays the failure
`--attempts` times (default 3) in fresh browser sessions. A failure that does not reproduce every
time is labelled flaky and is not committed.

What it can use as the failure (the "oracle"):

- **A failed goal success check** (`--result` from a goal run): the check is appended to the
  Recording as its final assertion. The Recording is then **minimized** with delta debugging
  (Zeller's ddmin), keeping only the steps the failure still needs.
- **An app-caused failed action** in the run's transcript (for example a control the app never
  rendered): it becomes a final "this control is visible" step, then minimized the same way.
- **A failed network check** (`requestMade` / `responseStatus`), re-evaluated on replay.
- **A declared invariant violation** (`--fingerprint` of an `invariant` defect in `--result`): the
  invariant is re-checked on replay up to the step where it fired, the same way `verify-fix` does.
  This Recording is not minimized.
- **A Recording whose final step's `expect` fails**, with no `--result` at all.

It refuses, with a reason, when the result carries none of these. In particular, the engine's own
safety refusals are never used as an oracle, and a hard-signal defect such as an HTTP 500 is
re-checked with `verify-fix` rather than captured. To capture one of those as a regression,
declare the rule it breaks as an [invariant](./invariants.md) (the [demo](./demo.md) does this).

`regression run <id>` replays the committed files and re-evaluates the same oracle: `reproduces`
(exit 1) while the bug is there, `fixed` (exit 0) once it is gone. Pass `--storage-state` to
either command for an authenticated app, and `--fixtures` to capture when the failing run started
from [fixtures](./fixtures.md).

## Keeping findings verifiable: the ledger

`verify-fix --result` needs the result file that contained the defect. Run output under
`.jevitate/logs/` is deleted by retention, but checking months later that a fix still holds needs the
same repro material. The ledger stores that material, keyed by fingerprint, in the committed
regressions store:

```bash
jevitate ledger add .jevitate/logs/<date>/feature-<stamp>.result.json <fp> --ticket JEV-123
# → .jevitate/regressions/ledger/<fp>.json  (commit it with the fix)

jevitate verify-fix <fp>                 # one finding, from the ledger (no --result needed)
jevitate ledger verify                   # every entry; --ticket JEV-123 or <fp>... to narrow it
jevitate ledger list                     # what is in the ledger
```

Each entry is a small, self-contained result that `verify-fix` replays like the original. It
contains only what the replay needs:

- the finding, with its own Recording when it has one, or else the run's Recording;
- the run's scope (`seedUrl` and `allowlist`);
- the declared invariant spec, for an invariant defect;
- the fixture spec, the hashes of its `--before`/`--after` hooks, and its non-secret outputs;
- the names of the controls that sent a write, for hang-replay safety.

An entry never contains a storage state, a storage-state path, an actor's session, the transcript,
page text, screenshots or usage. To verify an authenticated target, pass `--storage-state` to
`verify-fix` or `ledger verify`, or set the target's session in `~/.jevitate/targets.json`. Pass
`--secret <value>` (repeatable) to `ledger add` to refuse any entry that would contain that value.
`--dir` (for `ledger`) or `--regressions-dir` (for `verify-fix`) selects a regressions directory
other than the repo's `.jevitate/regressions`.

`ledger verify` exits with the worst verdict across the entries it checked, in this order:
`still-reproduces` (1), then `intermittent` (4), then `inconclusive` (2). It exits 0 only when every
entry is `fixed`. An entry that cannot be replayed, for example because its session is missing,
counts as `inconclusive` and never as fixed.

## Reproducing a finding: `verify-fix`



The adversarial mission keeps hunting after a defect until its step, action or
time budget runs out. Defects are deduplicated by a stable fingerprint, and each
one carries its reproduction: the transcript steps that led to it and the
Recording step to replay up to. To check a fix, replay the defect:

```bash
jevitate verify-fix --result .jevitate/logs/<date>/adversarial-<stamp>.result.json --fingerprint <fp> --replays 3
# exit 0 fixed (signal absent on every replay) · 1 still reproduces · 2 inconclusive (replay could
# not reach the step) · 4 intermittent (fired on some but not all replays — never reported as fixed)
```

A single clean replay is not evidence of a fix (#74): an intermittent signal can simply not fire
once. `verify-fix` replays the defect's repro `--replays` times (default 3), each in a fresh
session; only absence across EVERY replay that reached the defect's step is `fixed`.

The MCP tool `verify_fix` (`{ id, fingerprint }`) does the same, always with the default replay count.

## Replay finds the recorded element exactly

A replay (a Journey, `verify-fix`, a hang reproduction) never clicks a guess:

- It uses a stable anchor captured at record time when there is one: a test id,
  or a non-generated, document-unique `id` or `name` attribute. It stores
  identifiers only, never a field's value.
- Otherwise it matches the recorded role and accessible name, label or text
  **exactly**, never by substring or prefix, so "Stuck report" is never
  "Stuck report again". Among elements with the same name, it uses the recorded
  index. If the number of such elements changed since recording, the step fails
  instead of clicking whatever element now sits at that index.
- A target that is missing, or that cannot be told apart from others, fails the
  step with a typed `replay-target-not-found` or `ambiguous` result.
  `verify-fix` reports that as `inconclusive`, never as `fixed`.

Older recordings without anchors or recorded counts still replay, by exact
name plus index.
