---
name: jevitate-record
description: Record a flow the human clicks through (`jevitate record --url`, CLI only, headed), then post-process the takes: propose an unpromoted draft Journey from 2+ takes, diff them, classify values (postdoc), fit a timing policy, promote a value to a variable (`jevitate recording ...`, MCP `recordings`). Use when the user wants to demonstrate a flow themselves. If they want jevitate to find and save the flow for them, use `explore-author-journey` (jevitate-explore).
---

You drive Jevitate's human-driven authoring mode (RxD): capturing a take from a
live demonstration, then post-processing one or more takes into a clean,
parameterized `Recording` a Journey can be built from. Capture is a live,
headed browser demonstration a human performs — you launch it and they drive.

## Capture a take (live demonstration)

- `jevitate record --url <authorized-url> [--intent "<framing>"] [--retro
  "<note>"] [--allow <origin>] [--out <dir>] --json` opens a headed browser at
  an authorized origin and records the human's demonstrated flow into a
  take file `{ "recording": <Recording>, "values": {...} }` (default `.jevitate/logs/<date>/` in the repo, else
  `~/.jevitate/logs/<date>/`). The session is
  headed by design — a record session IS a live human demonstration; add
  `--headless` only when a caller explicitly asks. The target must be
  authorized (`--allow` REPLACES the default allowlist when given at all —
  it defaults to `--url`'s own origin only when `--allow` is omitted
  entirely; include that origin explicitly in `--allow` if you still need
  it), and an unauthorized target is refused (`E_UNAUTHORIZED_EXPLORE_TARGET`).
- **Ending a take**: press Enter on stdin, or send SIGINT (Ctrl-C) — both end
  the take the SAME way (the demonstrated steps are stopped and written to
  disk). This matters most for `--headless`, where there is no visible
  window to interact with: Ctrl-C is the way to end a headless take, and it
  saves the take rather than killing the process and losing it.
- The emitted `recordingPath` is the take file: feed it straight to `recording
  diff`/`postdoc`/`promote`/`fit`. `values` holds non-secret captured text/select
  values only (a secret, credential or OTP field never gets one) and stays local,
  so treat the logs dir accordingly: do not commit or share it. Capture two or more takes of the same flow (varying the data each
  time) when you want `diff` to classify which values are variables.

- `record` is never an MCP tool (a person does the clicking). As an agent, give the human the
  command to run, and wait for the `recordingPath` it prints. `propose`/`diff`/`fit`/`postdoc`/`promote`
  are available over MCP as the `recordings` tool (`action`). Over MCP, captured values never come
  back: `diff` returns hints (length, shape, words), and `postdoc` returns constants redacted.

## Propose bindings (after two or more takes) — the usual next step

- `jevitate recording propose <takeA.json> <takeB.json> [more...] --id <draft-id> --json` (MCP
  `recordings` `{action: "propose", take, more, id}`) proposes params (varying typed/selected
  values and URL segments), constants, credential handbacks, outputs (identifiers shown before the
  first write), `{var}` checks (`pre-write` identity, `post-write` exact value), and `stopBefore`
  (the Send/Submit step the draft ends before). It saves an UNPROMOTED draft Journey in the journeys
  store (`--out <file>` writes it elsewhere, `--no-draft` saves none). It never overwrites an
  existing Journey (`E_PROPOSAL_DRAFT_EXISTS`), and never promotes or approves anything.
- **Ambiguities are the human's.** Show every `ambiguities[]` entry (its `kind` and `stepIds`) to
  the human and let them decide. Do not resolve them yourself. When `stopBefore` is absent
  (`no-submit-step`), the draft replays EVERY step, including the final submit. Have the human mark
  the stop before anything runs it.
- Then follow `jevitate-promotion-ready`: `jevitate journey review <id> --strict` and `jevitate
  journey verify <id> --mutate --param <name>=<value> ...` (on a non-production environment). The
  mutation proof swaps and truncates each proposed parameter to prove the `{var}` checks catch a
  wrong thread or truncated text. Promotion stays the human's.
- Fewer than two takes (`E_PROPOSAL_TOO_FEW_TAKES`) and takes that did not record the same steps
  (`E_PROPOSAL_MISALIGNED`) are usage errors (exit 64). Re-record the takes so they follow the same
  steps.

## Diff multiple takes

- `jevitate recording diff <takeA.json> <takeB.json> [more.json...] --json` —
  compares fill/select steps across takes and classifies each varying value
  (constant vs. likely-variable) with a confidence score. Read the confidences;
  do not treat a low-confidence classification as settled — surface it to the
  human via `postdoc` instead of deciding for them.
- **Input shape**: `diff`/`postdoc`/`promote`/`fit` take the `{ "recording",
  "values" }` take file `jevitate record` writes. A raw `Recording` (what
  `explore` or `explore-author-journey` write) has no `values` and is refused with
  `E_INVALID_TAKE`; diff takes made by `jevitate record`.

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
  skipping the full diff/postdoc review flow. This is how a NON-secret value
  (an email, a SKU) becomes a Journey parameter: it sets the step's `variableName`
  (the `{var}` binding). `explore-author-journey` only auto-parameterizes secret
  fields.

## Publishing the result

- The output of `postdoc`/`promote` is a `Recording` JSON file — one authoring
  artifact short of a runnable Journey. Two autonomous authoring paths write a
  Journey directly from a goal-based exploration: `jevitate
  explore-author-journey` (see `jevitate-explore`) emits an UNPROMOTED,
  parameterized Journey a human must still promote. To share a promoted local
  Journey to a distributed source, use `jevitate journey publish <id> --to
  <source>` (see `jevitate-sources`).

Before handing a Journey made from a Recording to its owner, follow
`jevitate-promotion-ready`: done means `jevitate journey review <id> --strict` passes.

## Known gaps

- `recording propose` turns takes into an UNPROMOTED draft Journey. A `postdoc`/`promote`
  result is still only a `Recording`, and promotion stays a deliberate human gate. `jevitate explore-author-journey` is a
  separate, Jev-driving authoring path (not human capture) that may be what a
  user who wants a Journey "recorded for them" actually needs.
