---
name: jevitate-record
description: Capture a demonstrated browser flow into a Recording (`jevitate record --url`) and post-process it — diff multiple takes, review/classify fill steps (postdoc), fit a timing policy, promote a value to a variable — via the jevitate CLI. Use to record human-demonstrated takes and turn them into a parameterized, replayable artifact.
---

You drive Jevitate's human-driven authoring mode (RxD): capturing a take from a
live demonstration, then post-processing one or more takes into a clean,
parameterized `Recording` a Journey can be built from. Capture is a live,
headed browser demonstration a human performs — you launch it and they drive.

## Capture a take (live demonstration)

- `jevitate record --url <authorized-url> [--intent "<framing>"] [--retro
  "<note>"] [--allow <origin>] [--out <dir>] --json` opens a headed browser at
  an authorized origin and records the human's demonstrated flow into a
  `Recording` JSON file (default `~/.jevitate/recordings`). The session is
  headed by design — a record session IS a live human demonstration; add
  `--headless` only when a caller explicitly asks. The target must be
  authorized (defaults to `--url`'s own origin; widen only with explicit
  `--allow`), and an unauthorized target is refused
  (`E_UNAUTHORIZED_EXPLORE_TARGET`).
- The emitted `recordingPath` is the take you then feed into the diff/postdoc
  flow below. Capture two or more takes of the same flow (varying the data each
  time) when you want `diff` to classify which values are variables.

## Diff multiple takes

- `jevitate recording diff <takeA.json> <takeB.json> [more.json...] --json` —
  compares fill/select steps across takes and classifies each varying value
  (constant vs. likely-variable) with a confidence score. Read the confidences;
  do not treat a low-confidence classification as settled — surface it to the
  human via `postdoc` instead of deciding for them.

## Review and classify (postdoc)

- `jevitate recording postdoc <take1.json> [more.json...] --decisions <decisions.json> --out <result.json> --json`
  applies a `PostdocDecision[]` (one decision per varying fill/select step:
  `classify: "constant" | "variable" | "handback"`, with a `name` for
  `"variable"` or a `prompt` for `"handback"`) non-interactively. Build the
  decisions file yourself from the `diff` output and the user's stated intent
  (e.g. "the quantity should be a variable, everything else is fixed") — do not
  ask the human to run the interactive prompt flow when you already know the
  answer from context.
- Without `--decisions`, `postdoc` is interactive (prompts a human at the
  terminal) — only omit `--decisions` when you are explicitly handing control
  to a human, not when driving autonomously.

## Fit a timing policy

- `jevitate recording fit <recording.json> --json` derives a `SitePolicy`
  (interaction timing) from a recording's captured pacing. Hand the result to
  `jevitate site policy set <site> --file <policy.json>` if the user wants it
  applied.

## Promote a value to a variable directly (single-take shortcut)

- `jevitate recording promote <file.json> --page <n> --step <n> --var <name>` —
  for the simple case of a single take with one known value to parameterize,
  skipping the full diff/postdoc review flow.

## Publishing the result

- The output of `postdoc`/`promote` is a `Recording` JSON file — one authoring
  artifact short of a runnable Journey. Two autonomous authoring paths write a
  Journey directly from a goal-based exploration: `jevitate
  explore-author-journey` (see `jevitate-explore`) emits an UNPROMOTED,
  parameterized Journey a human must still promote. To share a promoted local
  Journey to a distributed source, use `jevitate journey publish <id> --to
  <source>` (see `jevitate-sources`).

## Known gaps

- There is no single-command "postdoc result -> promoted local Journey" verb: a
  `Recording` produced here still becomes a Journey through the authoring paths
  above (`explore-author-journey`) or the `JourneyRegistry` API, and promotion
  stays a deliberate human gate. `jevitate explore-author-journey` is a
  separate, Jev-driving authoring path (not human capture) that may be what a
  user who wants a Journey "recorded for them" actually needs.
