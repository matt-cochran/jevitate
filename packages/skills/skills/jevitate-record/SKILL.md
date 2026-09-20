---
name: jevitate-record
description: Post-process a captured Jevitate Recording — diff multiple takes, review/classify fill steps (postdoc), fit a timing policy, and promote a value to a variable — via the jevitate CLI. Use after a human has recorded one or more takes of a browser flow and wants to turn them into a parameterized, replayable artifact.
---

You drive the **post-processing** half of Jevitate's human-driven authoring mode
(RxD). A human has already recorded one or more "takes" (raw `Recording` JSON
files, each produced by stepping through a browser flow) — your job is to turn
those takes into a clean, parameterized `Recording` a Journey can be built from.
You do not capture the recording yourself; there is no CLI step for that in this
skill (see Known gaps).

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

## Known gaps (as of 2026-09-20)

- There is no CLI command to **capture** a take from a live browser session in
  this skill's scope (ticket #22, `jevitate record`, is still pending) —
  recording capture is driven by `@jevitate/recorder`'s browser-injection
  primitives, not yet wrapped in a `jevitate` CLI verb. If a user asks you to
  "record a new take," tell them capture isn't yet a CLI command and ask how the
  existing take file was produced (or point them at a human with repo access),
  rather than inventing a `jevitate record start`-style command that does not
  exist. Note: `jevitate explore-author-journey` (see `jevitate-explore`) is a
  separate, Jev-driving authoring path that emits its own takes autonomously —
  it is not human capture, but it may be what a user actually wants.
- There is no CLI command to publish the `postdoc` result as a runnable Journey
  (see `jevitate-run-journey`'s Known gaps, ticket #19) — the output of
  `postdoc`/`promote` is a `Recording` JSON file, one step short of a promoted
  `Journey`.
