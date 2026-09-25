# Demo: find a silent failed save, prove it, lock it in, verify the fix

This is the reproducible demo behind the README and the launch recording. It runs locally against
the repository's own example app, needs **no API keys**, and takes about two minutes, most of it
the adversarial run (about 45 seconds).

## What it proves

A small profile form has one planted bug: saving a display name with a character outside Latin-1
(an emoji, Arabic, Cyrillic) makes the server return **HTTP 500**, and the page still says
**"Saved"** because it only checks for 4xx errors. A person clicking through with an ordinary
name never sees it.

The demo shows the whole loop:

1. **Explore.** An adversarial mission misuses the form (double submits, empty, long, unicode and
   invalid values, reload with unsaved edits, acting while a save is pending).
2. **Detect, with evidence.** Two findings, both decided by code: the HTTP 500 (a hard signal),
   and a violation of an app-declared invariant, "when the page says Saved, the server has the
   name that was typed" (`apps/example-site/demo-invariants.json`).
3. **Reproduce.** `verify-fix` replays the finding in 3 fresh browser sessions: still reproduces.
4. **Lock it in.** `regression capture` commits the invariant violation as a regression, and
   `regression run` fails on it.
5. **Verify the fix.** Restart the app with the fix, and the same regression and re-check pass.

No model decides anything here. The adversarial mission plans its misuse in code, and
`--fake-ai` replaces the only model calls it makes (an advisory "does this look broken?" and the
issue-draft triage text) with deterministic stand-ins. With `--real`, Jev adds advisory triage.
The findings are the same, because models never decide them.

## Prerequisites

- Node.js 20+, pnpm 9, `git`, and `jq` (used only to trim the JSON output).
- A few hundred MB of disk space for dependencies and Chromium. On a fresh Linux machine, use
  `playwright install --with-deps chromium` to also install Chromium's system libraries.

## Setup (once)

```bash
git clone https://github.com/matt-cochran/jevitate.git
cd jevitate
pnpm install
pnpm -r build
pnpm --filter @jevitate/cli run bundle
pnpm --filter @jevitate/cli exec playwright install chromium
```

Use the CLI you just built:

```bash
alias jevitate="node $PWD/packages/cli/dist/bin.js"
```

(Or, once v0.2.0 is published, `npm install -g @jevitate/cli`. The demo app still comes from
this repository.)

## Run it

**Terminal 1**, the app under test (it listens on `http://127.0.0.1:5190`, loopback only):

```bash
pnpm --filter @jevitate/example-site demo
```

**Terminal 2**, from the repository root:

```bash
# 1. Try to break the profile form (~45 s). Exit code 1: defects found.
jevitate explore --strategy adversarial --url http://127.0.0.1:5190/demo/profile \
  --invariants apps/example-site/demo-invariants.json --fake-ai --out demo-runs \
  | jq '.data | {outcome, defects: [.defects[] | {kind, title, fingerprint}]}'

# 2. Pick up the run's result, its Recording and the two fingerprints.
RESULT=$(ls -t demo-runs/adversarial-*.result.json | head -1)
RECORDING="${RESULT%.result.json}.json"
FP_500=$(jq -r '[.result.defects[] | select(.kind == "http-5xx")][0].fingerprint' "$RESULT")
FP_INV=$(jq -r '[.result.defects[] | select(.kind == "invariant")][0].fingerprint' "$RESULT")

# 3. Reproduce the 500 in fresh sessions. Exit code 1: still reproduces.
jevitate verify-fix --result "$RESULT" --fingerprint "$FP_500" | jq '.data | {verdict, reason}'

# 4. Commit the broken rule as a regression, then run it. Exit code 1: reproduces.
jevitate regression capture --from "$RECORDING" --result "$RESULT" --fingerprint "$FP_INV" \
  --id saved-means-stored --dir demo-regressions
jevitate regression run saved-means-stored --dir demo-regressions
```

Now "fix the bug". In **terminal 1**, press Ctrl+C and restart the app with the fix switched on:

```bash
DEMO_FIXED=1 pnpm --filter @jevitate/example-site demo
```

Back in **terminal 2**:

```bash
# 5. The same regression and re-check now pass. Exit code 0: fixed.
jevitate regression run saved-means-stored --dir demo-regressions
jevitate verify-fix --result "$RESULT" --fingerprint "$FP_500" | jq '.data | {verdict, reason}'
```

To run it again from scratch: `rm -rf demo-runs demo-regressions` (both are git-ignored).

## Expected sequence

Recorded from a real run of the commands above (engine `0.1.0`, commit `098cdeb`; the timestamp
in file names will differ). Fingerprints are stable for the same URL.

```text
$ jevitate explore --strategy adversarial ... | jq ...
{
  "outcome": "defects-found",
  "defects": [
    { "kind": "http-5xx",  "title": "HTTP 500 from /demo/api/profile", "fingerprint": "b8b841bad287ceb7" },
    { "kind": "invariant", "title": "Invariant \"saved-means-stored\" violated on /demo/profile", "fingerprint": "49f32071d05edec4" }
  ]
}

$ jevitate verify-fix ... | jq ...
{ "verdict": "still-reproduces",
  "reason": "the defect's fingerprint fired on all 3/3 replay(s) that ran (the original run observed it 3 time(s))" }

$ jevitate regression capture ...
{"recordingPath":"demo-regressions/saved-means-stored.recording.json","metaPath":"demo-regressions/saved-means-stored.meta.json", ...}

$ jevitate regression run saved-means-stored --dir demo-regressions
{"id":"saved-means-stored","verdict":"reproduces","reason":"the defect's fingerprint fired on all 3/3 replay(s) that ran"}

# after restarting the app with DEMO_FIXED=1
$ jevitate regression run saved-means-stored --dir demo-regressions
{"id":"saved-means-stored","verdict":"fixed","reason":"the defect's fingerprint was absent on all 3/3 replay(s) that ran"}

$ jevitate verify-fix ... | jq ...
{ "verdict": "fixed",
  "reason": "the defect's fingerprint was absent on all 3/3 replay(s) that ran (the original run observed it 3 time(s))" }
```

(The JSON output is trimmed and reformatted. The full result also carries the invariant's before
and after values, for example `typedName: "مرحبا 😀 тест"` against `storedName: "test-value"`,
the steps to reproduce, and a ready-to-file issue draft under `demo-runs/*.issues/`.)

Things worth pointing out in the output:

- `demo-runs/adversarial-*.issues/<fingerprint>.md` is a redacted, ready-to-file issue with
  numbered reproduction steps and the evidence.
- The invariant regression replays up to the step where it fired. A regression captured from a
  failed goal `--success` check is also **minimized** (delta debugging). See
  [verification.md](./verification.md).
- The 500 itself is re-checked with `verify-fix`. In CI, `jevitate check --suite` does the same
  from a suite's `verifyFix` entries ([ci.md](./ci.md)).

## Recording the launch GIF or video

Target: 20 to 30 seconds, a 1280×720 or larger terminal, a large font (18 pt or more), and a dark
theme with high contrast. Don't show your home directory, other projects or any keys.

1. Do the setup above beforehand, and run the whole demo once so Chromium and the build are warm.
   Then `rm -rf demo-runs demo-regressions`.
2. Use two panes side by side: the app (terminal 1) on the left, `jevitate` (terminal 2) on the
   right. Optionally show a small browser window with `http://127.0.0.1:5190/demo/profile` and
   save "Zoë 😀" by hand first: the page says "Saved", and `GET /demo/api/profile` still shows
   the old name. That is the "looks fine to a human" beat.
3. Record these beats. Speed up or cut the ~45-second exploration, and label the cut on screen
   ("45 s, sped up"):
   - 0 to 3 s: the one-line explore command.
   - 3 to 10 s: `outcome: defects-found`, with the two findings, a 500 and the invariant.
   - 10 to 15 s: `verify-fix`, `still-reproduces` on 3/3 replays.
   - 15 to 21 s: `regression capture`, then `regression run` → `reproduces`.
   - 21 to 24 s: restart the app with `DEMO_FIXED=1`.
   - 24 to 30 s: `regression run` → `fixed`.
4. End card: "Nondeterministic discovery. Deterministic verification." plus `jevitate.com` and
   `github.com/matt-cochran/jevitate`.
5. Export an MP4 (for the website and social posts) and a GIF of at most about 10 MB for the
   README. Save them as `docs/assets/demo.mp4`, `docs/assets/demo.gif` and a still
   `docs/assets/demo-poster.png`. Then replace the demo placeholder at the top of the README (and
   the website's demo slot, `public/demo/`) with them.

Tools that work well: [asciinema](https://asciinema.org) with [agg](https://github.com/asciinema/agg)
for a terminal-only GIF, or any screen recorder for the two-pane version. Record real output only.
Do not re-type or edit the JSON.
