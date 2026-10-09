---
name: jevitate-run-journey
description: Find and replay a promoted jevitate Journey (a saved, deterministic browser flow such as a login, checkout or form submission) by id with typed params, on any named environment (`--env`/`--base-url`), optionally with video and screenshots and self-heal. Runs via `jevitate journey find|run` or MCP `find_capabilities`/`run_journey`. Also covers promoting (human-only). Use when a known flow should be re-run or regression-checked, not explored or recorded fresh.
---

You drive already-published, promoted Jevitate Journeys. You never write or invent
automation steps yourself — a Journey is a deterministic, pre-recorded, reviewed
artifact; your job is to find the right one and run it with the right params.

## Discover

- CLI: `jevitate journey find "<query>" --json` — searches promoted Journeys by
  name/description. Returns `{ id, name, description, params }[]`.
- MCP: `find_capabilities(query)` returns the same shape. Prefer this when you are
  already inside an MCP-connected session — it is scoped to the same
  promoted-only allowlist.
- `jevitate journey list --json` shows ALL Journeys including unpromoted ones —
  use this only for authoring/debugging with a human present, never to find
  something to run autonomously (an unpromoted Journey is unpromoted for a
  reason and `journey run`/`run_journey` will refuse it anyway).

## Run

- CLI: `jevitate journey run <id> --param key=value --param key2=value2 --json`.
  Every param the `find`/`find_capabilities` result listed under `params` is
  required; passing an unknown param key is a refusal (`E_INVALID_PARAMS`), not
  a silent ignore. An unknown id is `E_UNKNOWN_JOURNEY`.
- MCP: `run_journey({ id, params, storageState? })` — same param-schema
  validation, same refusal on an unknown id or params. It NEVER accepts inline
  steps or a raw recording — a published id only.
- Read the JSON envelope's `outcome` field (MCP: also `exitCode`). Only `"ok"`
  (exit 0) is a pass. `"healed-pending-review"` (exit 5) is NOT a pass: a
  self-heal retargeted steps and proposed a Journey revision a person must
  accept. `"heal-exhausted"` and `"quarantined"` (exit 1) and any other value,
  including a secret-handback pause, mean it did not complete — report that
  honestly, with the step it stopped at. Exit 64 is a refusal before anything
  ran (unknown id, bad params, a step off the allowlist).

## Where it runs (`--env`) and what it records

- `--env <name>` replays on a named environment from the repo's
  `.jevitate/environments.json` (its `baseUrl` plus `allow`); `--base-url <origin>`
  is an ad-hoc one (e.g. a preview deploy). Without either, the Journey runs on
  the site it was recorded on. A step on an origin the environment doesn't allow
  is refused (64) before any browser opens. MCP: `run_journey`'s `env`/`baseUrl`.
- Evidence: `--record-video` (listed as `videoPaths`), `--screenshots
  [screens|steps]` (`screenshotPaths` + an `index.md`), `--headed`/`--slow-mo <ms>`
  to watch it. `--viewport 375x812` / `--device "iPhone 13"` for mobile.
- For a narrated demo video or a step-by-step guide of a Journey, use
  `jevitate-demo` (`journey demo`, `journey annotate`).

## Authenticated Journeys (#118)

- A Journey authored behind a login needs a deterministic authenticated
  pre-step to replay: `--storage-state <file>` (a Playwright storageState JSON
  path — cookies + origin storage) on `jevitate journey run`, `jevitate load
  run`, and `jevitate source run`; over MCP, `run_journey`'s optional
  `storageState` argument is the SAME thing — a file PATH on the machine
  running the MCP server, never raw cookie/session content in the call itself.
  The file's contents are read only by the browser session; never logged,
  never echoed back.
- A Journey CAN declare `metadata.requiresAuth: true` if it only reaches its
  steps from an authenticated session. A run given no `storageState` then
  fails fast — before any browser opens — with `E_JOURNEY_REQUIRES_AUTH`
  naming the actual problem, instead of a confusing deep
  `replay-target-not-found` partway through the steps.

## Self-heal (optional, additive)

- `jevitate journey run <id> --self-heal <fail-closed|hybrid|full>` opts a run
  into scoped self-healing when a selector drifts. The default `fail-closed`
  preserves the plain, unhealed behavior. `hybrid`/`full` need an AI gateway
  (`--real` after `jevitate ai setup`, or `--fake-ai` for a pipeline smoke);
  requesting a heal mode without one fails closed rather than running unhealed.
- A heal mode also needs a change context, or it is refused (exit 64):
  `--changes <git range>` (e.g. `HEAD~1..HEAD`, read-only) and/or one or more
  `--change-note "renamed \"Create New\" to \"Create\""`. MCP: `changes`,
  `changeNote`. Only a break that change explains is retargeted, one step for
  one step; assertions, waits and request checks are never changed. A break the
  change does not explain stays `quarantined` (a likely regression).
- Budgets bound the heal: `--heal-max-attempts` (2) / `--heal-max-model-calls`
  (6) / `--heal-max-ms` per broken step; `--heal-max-run-attempts` (4) /
  `--heal-max-run-ms` per run. Exhausting them ends `heal-exhausted` (exit 1)
  with every attempt in the result.
- A healed run ends `healed-pending-review` (exit 5) and writes a proposal
  (`result.proposal`: id, path, steps, `reviewCommand`, `acceptCommand`); the
  stored Journey is untouched. Next: `jevitate journey review <id>` (MCP
  `review_journey`), then a person accepts with
  `jevitate journey promote <id> --proposal <pid>` or rejects with
  `--reject-proposal <pid> --reason "<text>"`. Do not accept a proposal on the
  user's behalf unless they asked you to. Show the user the changed steps and
  the evidence it cites.
- A write/irreversible step NEVER auto-heals in any mode — that floor is
  enforced by the runtime, not something you can override from a flag.

## What you must never do

- Never pass inline steps, a raw URL, or a selector anywhere in this flow — you
  only ever pass an `id` that came from `find`/`find_capabilities`.
- Never guess a param value that looks like a secret (a password, an API key) —
  if a Journey's params include something secret-shaped, tell the user it needs
  to be supplied by them or via the configured secret manager, never invent one.
- Never try to run an id you have not first seen in a `find`/`find_capabilities`
  result in this same session — a promoted id can be revoked; don't rely on a
  memorized id from an earlier conversation.

## Promoting a Journey

- Before asking the human to promote, give them the review sheet:
  `jevitate journey review <id> --markdown` (MCP `review_journey`) — steps,
  side effects (write requests, risky controls, origins), inputs by name,
  proof, change since the last approval, and the content hash. Pass that hash
  as `--reviewed-hash` (MCP `reviewedHash`) so the approval is refused
  (`E_JOURNEY_REVIEW_STALE`) if the Journey changed after they read it.
- `jevitate journey promote <id>` promotes a local Journey — a person's
  approval, never automatic. It needs an interactive terminal: after the
  sheet, the person types the Journey id (or the first 8 characters of its
  content hash), and again for each `--accept-*` waiver. From your shell it is
  refused (`E_APPROVAL_NEEDS_HUMAN`, exit 64) — so hand it to the person: the
  sheet, then "run `jevitate journey promote <id>` in your terminal". Never
  pass `--non-interactive-approval` yourself (scripted setups only; recorded
  as non-interactive, with your agent markers). MCP `promote_journey` works,
  but only when the human tells you to, and it is recorded as an agent's
  approval (`provenance.channel: "mcp"`) that `check --require-approvals`
  fails — it never counts as the person's sign-off. Every authored/recorded Journey starts
  `metadata.promoted: false` (`explore-author-journey`, `jevitate record` +
  `recording postdoc`); only a promoted Journey is discoverable via `journey
  find`/`find_capabilities` and runnable via `journey run`/`run_journey`.
  There is still no "raw Recording -> promoted Journey in one step" command —
  a Recording becomes a Journey first (through an authoring path, or the
  `JourneyRegistry` API), then `journey promote <id>` promotes it.

## Step intent (annotations)

- `journey run` reports `intent.withoutObjective` (steps with no stated objective). It is
  informational and never a failure. Drafting and approving objectives is `journey annotate`
  (see `jevitate-demo`); `--approve` is the human's call, like promote.

## Publishing to a distributed source

- `jevitate journey publish <id> --to <source>` pushes a PROMOTED local Journey
  up to a registered distributed source (see `jevitate-sources`). It preserves
  every publish-side guard: promoted-only, secret-references-only, and
  declared-origin coverage; it writes onto a new `publish/<id>` branch and,
  when `gh` is present, opens a PR. When `gh` is absent, or a PR can't be
  opened (e.g. the remote isn't GitHub), the branch is still pushed and the
  command still reports success (`pushed: true`, no PR) with instructions to
  open one manually — pushing the branch is never reported as a failure. It
  never publishes an unpromoted Journey.
